import type { CloudDb } from "../db";
import { env } from "../env";
import {
  EMAIL_INBOUND_MAX_ATTEMPTS,
  EMAIL_INBOUND_PENDING_CLAIM_MS,
  type InboundForwarder,
  type InboundOutcome,
  ingestInboundMessage,
} from "../services/email-inbound";
import type { InboundObjectFetcher } from "../services/email-inbound-objects";
import { isConfiguredSnsTopic } from "../sns/topics";
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
import type { InboundStore } from "./inbound-domains";
import {
  INBOUND_OBJECT_KEY_PREFIX,
  resolveInboundStore,
} from "./inbound-domains";
import { fail } from "./route-response";
import { parseSesInboundNotification } from "./ses-inbound-notifications";

/**
 * THE INBOUND SNS INGRESS (PRD 16 task 4) — `POST /api/email/inbound/[region]`.
 *
 * The TWIN of `email-event-ingress.ts`, deliberately step for step, because the
 * two endpoints have identical security requirements and a second posture would
 * be a second thing to keep right:
 *
 *   region -> body -> parse -> TOPIC -> SIGNATURE -> dispatch -> normalize
 *     -> ingest
 *
 *  - **the SNS verifier is the SAME one** (`src/sns/verify.ts`). PRD 05 already
 *    solved the certificate-URL allowlist, the redirect-is-a-rejection rule and
 *    the build-the-signed-string-from-a-fixed-field-set rule. A second verifier
 *    would be a second chance to get any of those wrong, on the endpoint that
 *    handles the more hostile payload;
 *  - **topic before signature**, because rejecting on an unverified field is
 *    always safe (we only ever refuse on it) and verification costs an outbound
 *    certificate fetch. A flood of foreign-topic messages therefore cannot make
 *    this endpoint fan requests out to AWS;
 *  - **signature before ANY byte is read from `Message`**, which here means
 *    before the S3 object is even named, let alone fetched. Without that, an
 *    anonymous POST would be a request for us to read an arbitrary object and
 *    a way to write rows into a tenant's inbound table;
 *  - **its own topic.** Inbound has `CLOUD_SES_INBOUND_TOPIC_ARN_*`, separate
 *    from the status topic, and an unconfigured region accepts NOTHING.
 *
 * The status codes are chosen for what they make SNS DO: a 200 stops the retry
 * and a non-2xx makes it re-drive on its own schedule. So a message we
 * deliberately did not emit for (an auto-responder, an oversized object, a
 * recipient nobody owns) answers 200 — retrying changes none of those — an
 * instance that was briefly unreachable answers 502 until the row's attempt
 * ceiling makes it terminal, and a row another request may hold RIGHT NOW
 * answers 503, never 200, because the retry a 200 would cancel is the only
 * thing that can recover the row if that other request died before settling it.
 */

export interface SesInboundIngressDeps {
  db?: CloudDb;
  /**
   * The region's bucket + topic. `undefined` reads the environment; `null`
   * means inbound is not configured here, which refuses everything.
   */
  store?: InboundStore | null;
  /** Injected in tests; the default fetches with redirects disabled. */
  fetchCertificatePem?: SnsCertificateFetcher;
  /** The S3 read seam. Injected so no test reaches AWS. */
  fetchObject?: InboundObjectFetcher;
  /** The outbound seam, for BOTH the instance hop and subscription confirm. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
  /** Overridable so a test can prove the size cap without a huge fixture. */
  maxObjectBytes?: number;
  /** The mandatory forward (task 6). Injected so no test reaches SES. */
  forward?: InboundForwarder;
}

/**
 * Bodies larger than this are refused unread.
 *
 * The NOTIFICATION is small by construction — SES caps the headers it publishes
 * at 10 KB and the message itself went to S3, which is the entire reason the
 * store action exists. So this bounds the envelope, and
 * `MAX_INBOUND_OBJECT_BYTES` bounds the mail.
 */
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

export async function handleSesInboundNotification(
  request: Request,
  regionParam: string,
  deps: SesInboundIngressDeps = {},
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

  // The region's store answers BOTH questions this endpoint has to ask — which
  // topic is expected, and which bucket a notification may name — and a
  // half-configured store is `null`, i.e. inbound is off here and nothing is
  // accepted. AWS's own guidance: "Reject any message with an unexpected
  // TopicArn to prevent spoofing."
  const store =
    deps.store !== undefined ? deps.store : resolveInboundStore(env, region);
  // TWO refusals, and they are separate because they fail closed for different
  // reasons. `!store` is "inbound is not configured in this region", which is a
  // MODE rather than a misconfiguration and must accept NOTHING rather than
  // everything — getting that backwards would turn a missing environment
  // variable into an open ingest endpoint. The second is the topic itself. A
  // `null` topic is unrepresentable here (`resolveInboundStore` returns null
  // unless BOTH the bucket and the topic are set), so the comparison is a
  // straight one and no fallback accessor is reached for.
  if (!store || !isConfiguredSnsTopic(store.topicArn, message.TopicArn)) {
    return fail(
      403,
      "unknown_topic",
      "That message is not from this region's SES inbound topic.",
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
    // but it is worth saying out loud, because replies stop arriving.
    return ok({ ok: true, action: "unsubscribe_acknowledged" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.Message);
  } catch {
    return ok({ ok: true, action: "ignored", reason: "message_not_json" });
  }

  const parsed = parseSesInboundNotification(payload, {
    bucket: store.bucketName,
    objectKeyPrefix: INBOUND_OBJECT_KEY_PREFIX,
    region,
  });
  if (!parsed.ok) {
    // 200, not an error: a rule publishing something this endpoint does not
    // consume is a provisioning bug to fix, not a reason to have SNS retry it
    // for days. The reason is named so the fix is findable.
    return ok({ ok: true, action: "ignored", reason: parsed.reason });
  }

  const outcome = await ingestInboundMessage(
    { region, notification: parsed.notification },
    {
      db: deps.db,
      fetchObject: deps.fetchObject,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now,
      maxObjectBytes: deps.maxObjectBytes,
      forward: deps.forward,
    },
  );

  return outcomeResponse(outcome);
}

function outcomeResponse(outcome: InboundOutcome): Response {
  if (outcome.status === "in_flight") {
    // Seen, NOT settled, and not claimable yet — a concurrent request may be
    // at the wire, or the claim window has not elapsed. Never a 200: SNS
    // treats a 200 as delivered and stops retrying forever, and if the row was
    // actually abandoned (the process died before `settle`), the retry a 200
    // would cancel is the only thing that could ever recover the reply. Same
    // 503 the status wire answers, for the same reason.
    return fail(
      503,
      "inbound_in_flight",
      "This message is being handled by another request; retry shortly.",
      {
        "retry-after": String(Math.ceil(EMAIL_INBOUND_PENDING_CLAIM_MS / 1000)),
      },
    );
  }
  if (outcome.status !== "failed") {
    return ok({
      ok: true,
      action: outcome.status,
      inboundId: outcome.messageId,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
    });
  }
  if (outcome.exhausted) {
    // TERMINAL. Answering non-2xx here would ask SNS to keep re-driving
    // something we have stopped attempting, which is a lie told for days. The
    // raw message is still in S3 and still referenced by the row.
    return ok({
      ok: false,
      action: "failed",
      inboundId: outcome.messageId,
      attempts: outcome.attempts,
      exhausted: true,
    });
  }
  // Ask SNS to come back. Its retry policy is the durable one; the row's
  // ceiling (`EMAIL_INBOUND_MAX_ATTEMPTS`) is what stops it being forever.
  return Response.json(
    {
      error: "instance_delivery_failed",
      message: outcome.error,
      inboundId: outcome.messageId,
      attempts: outcome.attempts,
      maxAttempts: EMAIL_INBOUND_MAX_ATTEMPTS,
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
  deps: SesInboundIngressDeps,
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
