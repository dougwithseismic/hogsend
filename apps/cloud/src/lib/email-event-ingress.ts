import type { CloudDb } from "../db";
import {
  EMAIL_EVENT_MAX_ATTEMPTS,
  type EmailEventOutcome,
  ingestSesEvent,
} from "../services/email-events";
import { isConfiguredSesEventTopic, sesEventTopicArn } from "../sns/topics";
import {
  assertSnsHttpsUrl,
  fetchSnsCertificatePem,
  parseSnsMessage,
  type SnsCertificateFetcher,
  type SnsMessage,
  SnsVerificationError,
  verifySnsMessage,
} from "../sns/verify";
import type { SubstrateRegion } from "../substrate/types";
import { fail } from "./route-response";
import { normalizeSesNotification } from "./ses-events";

/**
 * THE SNS INGRESS (PRD 05 task 3) — `POST /api/email/events/[region]`.
 *
 * The order of operations is the security posture, and each step is here
 * because the step after it is expensive or irreversible:
 *
 *   region → body → parse → TOPIC → SIGNATURE → dispatch → normalize → ingest
 *
 *  - **topic before signature.** Rejecting on an unverified field is always
 *    safe (we only ever refuse on it), and verification costs an outbound
 *    certificate fetch. Checking the cheap discriminator first means a flood of
 *    foreign-topic messages cannot make this endpoint fan out requests to AWS.
 *    Nothing is ACTED on before the signature — only refused;
 *  - **signature before anything is read from `Message`.** The SES payload is
 *    attacker-controlled until the signature says otherwise, and what it drives
 *    is a tenant's suppression list;
 *  - **subscription confirmation is explicit** and only for a topic we own, and
 *    even then the `SubscribeURL` runs through the SNS host allowlist. Blindly
 *    GETting whatever URL arrives is the same SSRF as an unvalidated
 *    `SigningCertURL`, by another door.
 *
 * The status codes are chosen for what they make SNS DO, which is a real
 * decision rather than cosmetics: a 200 stops SNS retrying and a non-2xx makes
 * it re-drive on its own schedule. So an event we deliberately dropped answers
 * 200 (retrying changes nothing), and an instance that was briefly unreachable
 * answers 502 (SNS's redelivery is the durable retry) until the row's attempt
 * ceiling makes it terminal.
 */

export interface SesEventIngressDeps {
  db?: CloudDb;
  /** The topic this region's events must arrive on. Defaults to the env. */
  topicArn?: string | null;
  /** Injected in tests; the default fetches with redirects disabled. */
  fetchCertificatePem?: SnsCertificateFetcher;
  /** The outbound seam, for BOTH the instance hop and subscription confirm. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

/** Bodies larger than this are refused unread. SES caps headers at 10 KB. */
const MAX_BODY_BYTES = 512 * 1024;

const REGIONS: readonly SubstrateRegion[] = ["us", "eu"];

function isRegion(value: string): value is SubstrateRegion {
  return (REGIONS as readonly string[]).includes(value);
}

/** A 200 that says what happened, for the SNS delivery log and for us. */
function ok(body: Record<string, unknown>): Response {
  return Response.json(body, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleSesEventNotification(
  request: Request,
  regionParam: string,
  deps: SesEventIngressDeps = {},
): Promise<Response> {
  if (!isRegion(regionParam)) {
    // 404 rather than 400: an endpoint for a region we do not serve does not
    // exist, and saying so reveals nothing about the ones that do.
    return fail(404, "unknown_region", "There is no endpoint for that region.");
  }
  const region = regionParam;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "That notification is too large.");
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return fail(413, "payload_too_large", "That notification is too large.");
  }

  let message: SnsMessage;
  try {
    message = parseSnsMessage(JSON.parse(body));
  } catch (error) {
    return fail(
      400,
      "invalid_message",
      error instanceof SnsVerificationError
        ? error.message
        : "That body is not an SNS message.",
    );
  }

  // AWS's own guidance: "Reject any message with an unexpected TopicArn to
  // prevent spoofing." An unconfigured region has no expected topic, so it
  // accepts nothing (see `sns/topics.ts`).
  const topicArn =
    deps.topicArn !== undefined ? deps.topicArn : sesEventTopicArn(region);
  if (!isConfiguredSesEventTopic(topicArn, message.TopicArn)) {
    return fail(
      403,
      "unknown_topic",
      "That message is not from this region's SES event topic.",
    );
  }

  try {
    await verifySnsMessage({
      message,
      fetchCertificatePem:
        deps.fetchCertificatePem ??
        ((url) => fetchSnsCertificatePem(url, { fetchImpl: deps.fetchImpl })),
    });
  } catch (error) {
    // 403 for EVERY verification failure, with the reason in the body and not
    // in the status. A hostile caller learns nothing about which check refused
    // them, and an operator reading a log sees exactly which one did.
    return fail(
      403,
      error instanceof SnsVerificationError
        ? `sns_${error.reason}`
        : "sns_signature",
      error instanceof Error ? error.message : "Signature verification failed.",
    );
  }

  // Verified, and on our topic. From here the payload is trustworthy.
  if (message.Type === "SubscriptionConfirmation") {
    return confirmSubscription(message, deps);
  }
  if (message.Type === "UnsubscribeConfirmation") {
    // Somebody unsubscribed this endpoint from the topic. Nothing to confirm —
    // re-subscribing ourselves would fight an operator's deliberate action —
    // but it is worth saying out loud, because events stop arriving.
    return ok({ ok: true, action: "unsubscribe_acknowledged" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.Message);
  } catch {
    return ok({ ok: true, action: "ignored", reason: "message_not_json" });
  }

  const normalized = normalizeSesNotification(payload);
  if (!normalized) {
    // A type we do not consume (`Send`, `Open`, `Click`, …). 200, not an error:
    // a configuration set publishing one is a provisioning bug to fix, not a
    // reason to have SNS retry it forever.
    return ok({ ok: true, action: "ignored", reason: "event_not_consumed" });
  }

  const outcome = await ingestSesEvent(
    { region, normalized },
    {
      db: deps.db,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now,
    },
  );

  return outcomeResponse(outcome);
}

function outcomeResponse(outcome: EmailEventOutcome): Response {
  if (outcome.status !== "failed") {
    return ok({ ok: true, action: outcome.status, eventId: outcome.eventId });
  }
  if (outcome.exhausted) {
    // TERMINAL. Answering non-2xx here would ask SNS to keep re-driving
    // something we have stopped attempting, which is a lie told for days.
    return ok({
      ok: false,
      action: "failed",
      eventId: outcome.eventId,
      attempts: outcome.attempts,
      exhausted: true,
    });
  }
  // Ask SNS to come back. Its retry policy is the durable one; the row's
  // ceiling (`EMAIL_EVENT_MAX_ATTEMPTS`) is what stops it being forever.
  return Response.json(
    {
      error: "instance_delivery_failed",
      message: outcome.error,
      eventId: outcome.eventId,
      attempts: outcome.attempts,
      maxAttempts: EMAIL_EVENT_MAX_ATTEMPTS,
    },
    { status: 502, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Confirm a subscription EXPLICITLY, for a topic we own, at a URL on the SNS
 * domain — never by GETting whatever arrived.
 *
 * The topic was already checked above, so by here the only open question is the
 * URL itself. A signed message naming an off-domain `SubscribeURL` is still
 * refused: the signature proves AWS sent it, not that the destination is one we
 * should reach out to from inside the control plane.
 */
async function confirmSubscription(
  message: SnsMessage,
  deps: SesEventIngressDeps,
): Promise<Response> {
  if (!message.SubscribeURL) {
    return fail(
      400,
      "missing_subscribe_url",
      "That subscription confirmation carried no SubscribeURL.",
    );
  }

  let url: URL;
  try {
    url = assertSnsHttpsUrl(message.SubscribeURL);
  } catch (error) {
    return fail(
      403,
      "invalid_subscribe_url",
      error instanceof Error
        ? error.message
        : "That SubscribeURL is not an SNS URL.",
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      // Same rule as the certificate fetch: a redirect is a rejection, not a
      // hop. An allowlist that follows redirects is decorative.
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return fail(
        502,
        "confirm_failed",
        `SNS answered ${response.status} to the confirmation.`,
      );
    }
  } catch (error) {
    return fail(
      502,
      "confirm_failed",
      error instanceof Error
        ? error.message
        : "The subscription confirmation could not be sent.",
    );
  }

  return ok({ ok: true, action: "subscription_confirmed" });
}
