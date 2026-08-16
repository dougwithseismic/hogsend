import type { CloudDb } from "../../../src/db";
import type { SesClient } from "../../../src/ses/contract";
import { resolveSesRegion } from "../../../src/ses/contract";
import { SesError, type SesMessage } from "../../../src/ses/types";
import type { SubstrateRegion } from "../../../src/substrate/types";
import { domainOfAddress, tenantScopedArn } from "../ses-walkthrough/arns";
import { type CleanupReport, CleanupStack } from "../ses-walkthrough/cleanup";
import { WALKTHROUGH_PUBLISHED_EVENT_TYPES } from "../ses-walkthrough/walkthrough";
import {
  PROOF_SCENARIOS,
  type ProofScenario,
  requireSimulatorRecipient,
  simulatorRecipient,
} from "./guards";
import type { ProofNames } from "./naming";
import {
  type ExpectedEvent,
  type ObservedEvent,
  observeEmailEvents,
} from "./observe";
import { registerProofStack, unregisterProofStack } from "./registration";
import type { ProofSnsClient } from "./sns";
import { type StubInstance, startStubInstance } from "./stub-instance";

/**
 * The proof itself: provision → event destination → stub stack → subscription
 * → simulator sends → observe → suppression probe → teardown, always.
 *
 * ## What each send is FOR
 *
 * `success+<runId>` / `bounce+<runId>` go through `sendEmail` and
 * `complaint+<runId>` through `sendBatch`, so BOTH send verbs — the two the
 * walkthrough could never run against AWS — are exercised, exactly once each
 * kind, with one message per scenario. The `+<runId>` label makes every event
 * legible to a human; the SES MESSAGE ID is the correlation key the observer
 * joins on, because it is what the ingress records.
 *
 * ## The report is the deliverable
 *
 * PRD 19's last EARS line: the run must name which links it exercised and
 * which it did NOT — a bare pass is a failure of the report. So the links are
 * a CLOSED list ({@link PROOF_LINK_IDS}), every one is initialised to
 * `not_exercised`, and only the step that actually ran may promote its link.
 * An aborted run therefore reports exactly how far it got, for free.
 *
 * ## Teardown
 *
 * The walkthrough's `CleanupStack`, reused: registered at creation time, run
 * in reverse, ALWAYS run — including on abort — and a failing undo is
 * REPORTED, never swallowed and never allowed to mask the run's own outcome.
 */

export const PROOF_LINK_IDS = [
  "tunnel_health",
  "sender_verified",
  "provision",
  "put_event_destination",
  "sns_subscription",
  "send_email",
  "send_batch",
  "event_delivered",
  "event_bounced",
  "event_complained",
  "instance_hop",
  "engine_terminal_status",
  "suppression_check",
  "reject_leg",
] as const;

export type ProofLinkId = (typeof PROOF_LINK_IDS)[number];

export type ProofLinkStatus = "exercised" | "not_exercised" | "failed";

export interface ProofLink {
  id: ProofLinkId;
  title: string;
  status: ProofLinkStatus;
  detail: string;
}

export const PROOF_LINK_TITLES: Record<ProofLinkId, string> = {
  tunnel_health: "cloudflared tunnel → control plane /api/health",
  sender_verified: "sender identity verified in SES",
  provision: "tenant + configuration set provisioned and associated",
  put_event_destination: "putEventDestination → SNS topic",
  sns_subscription: "sns:Subscribe + control-plane confirmation",
  send_email: "sendEmail → mailbox simulator",
  send_batch: "sendBatch → mailbox simulator",
  event_delivered: "Delivery: SES → SNS → ingress → email_events",
  event_bounced: "Bounce: SES → SNS → ingress → email_events",
  event_complained: "Complaint: SES → SNS → ingress → email_events",
  instance_hop: "signed instance hop → run-scoped stub stack",
  engine_terminal_status: "engine handleWebhook → email_sends terminal status",
  suppression_check:
    "simulator bounce NOT suppressed (judged by the probe's bounce subtype)",
  reject_leg: "Reject via EICAR attachment",
};

/** The runner owns `tunnel_health`; everything else is decided in here. */
const EXECUTE_LINK_IDS = PROOF_LINK_IDS.filter(
  (id): id is ProofLinkId => id !== "tunnel_health",
);

const EXPECTED_TYPE_BY_SCENARIO: Record<ProofScenario, string> = {
  success: "email.delivered",
  bounce: "email.bounced",
  complaint: "email.complained",
};

const EVENT_LINK_BY_SCENARIO: Record<ProofScenario, ProofLinkId> = {
  success: "event_delivered",
  bounce: "event_bounced",
  complaint: "event_complained",
};

/** How long the control plane gets to confirm the subscription. Generous —
 * SNS delivers the confirmation within seconds when the tunnel works at all. */
const DEFAULT_SUBSCRIBE_WAIT_SECONDS = 60;
const SUBSCRIBE_POLL_MS = 2_000;

export interface ProofStep {
  label: string;
  status: "ok" | "failed";
  detail?: string;
}

export interface ExecuteProofInput {
  client: SesClient;
  sns: ProofSnsClient;
  db: CloudDb;
  names: ProofNames;
  region: SubstrateRegion;
  sendFrom: string;
  /** Already https-validated and slash-stripped by the runner's guard. */
  publicUrl: string;
  topicArn: string;
  webhookSecret: string;
  observeSeconds: number;
  subscribeWaitSeconds?: number;
  /**
   * Test seam ONLY — there is no flag that reaches this. Every recipient,
   * overridden or derived, still passes {@link requireSimulatorRecipient}
   * BEFORE anything is created.
   */
  recipients?: Partial<Record<ProofScenario, string>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out?: (line: string) => void;
}

export interface ExecuteProofResult {
  steps: ProofStep[];
  /** Every id except `tunnel_health`, in {@link PROOF_LINK_IDS} order. */
  links: ProofLink[];
  events: ObservedEvent[];
  findings: string[];
  notes: string[];
  stub: { received: number; signatureFailures: number };
  cleanup: CleanupReport;
  probeMessageId?: string;
  aborted?: string;
}

/** A step failure that already recorded itself; carries the abort message. */
class ProofAbort extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProofAbort";
  }
}

export async function executeProof(
  input: ExecuteProofInput,
): Promise<ExecuteProofResult> {
  const { client, sns, db, names } = input;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? (() => Date.now());
  const out = input.out ?? (() => {});

  const cleanup = new CleanupStack();
  const steps: ProofStep[] = [];
  const notes: string[] = [];
  const findings: string[] = [];
  let events: ObservedEvent[] = [];
  let stub: StubInstance | undefined;
  let probeMessageId: string | undefined;
  let aborted: string | undefined;

  // Every link starts NOT exercised, so an aborted run reports exactly how far
  // it got. The two that stay that way on purpose carry their reason from the
  // start rather than a generic "not reached".
  const links = new Map<
    ProofLinkId,
    { status: ProofLinkStatus; detail: string }
  >(
    EXECUTE_LINK_IDS.map((id) => [
      id,
      {
        status: "not_exercised",
        detail: "not reached — the run ended earlier",
      },
    ]),
  );
  const setLink = (
    id: ProofLinkId,
    status: ProofLinkStatus,
    detail: string,
  ): void => {
    links.set(id, { status, detail });
  };
  setLink(
    "engine_terminal_status",
    "not_exercised",
    "by design: the stub verifies the signed hop with the plugin's own " +
      "verifier but is NOT an engine instance, so handleWebhook → email_sends " +
      "stays unproven here (see stub-instance.ts for the call)",
  );
  setLink(
    "reject_leg",
    "not_exercised",
    "Reject has no simulator address — it needs an EICAR attachment (PRD 17) " +
      "and, unlike simulator sends, is billed and counts against quota " +
      "(PRD 19 task 5)",
  );

  /** Run one step: record it, and on failure mark its link and abort. */
  const phase = async <T>(
    link: ProofLinkId | null,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    try {
      const value = await fn();
      steps.push({ label, status: "ok" });
      return value;
    } catch (error) {
      const detail = errorMessage(error);
      steps.push({ label, status: "failed", detail });
      if (link) setLink(link, "failed", detail);
      throw new ProofAbort(`${label} failed: ${detail}`, error);
    }
  };

  const finish = async (): Promise<ExecuteProofResult> => ({
    steps,
    links: EXECUTE_LINK_IDS.map((id) => {
      const state = links.get(id) ?? {
        status: "not_exercised" as const,
        detail: "not reached",
      };
      return { id, title: PROOF_LINK_TITLES[id], ...state };
    }),
    events,
    findings,
    notes,
    stub: {
      received: stub?.received.length ?? 0,
      signatureFailures:
        stub?.received.filter((receipt) => !receipt.signatureValid).length ?? 0,
    },
    ...(probeMessageId === undefined ? {} : { probeMessageId }),
    // ALWAYS, including on the abort path — the whole point of the stack.
    cleanup: await cleanup.run(),
    ...(aborted === undefined ? {} : { aborted }),
  });

  try {
    // -- simulator-only, before ANYTHING exists ----------------------------
    const recipients: Record<ProofScenario, string> = {
      success:
        input.recipients?.success ?? simulatorRecipient("success", names.runId),
      bounce:
        input.recipients?.bounce ?? simulatorRecipient("bounce", names.runId),
      complaint:
        input.recipients?.complaint ??
        simulatorRecipient("complaint", names.runId),
    };
    for (const scenario of PROOF_SCENARIOS) {
      requireSimulatorRecipient(recipients[scenario]);
    }

    // -- preflight the sender, creating nothing ----------------------------
    const identityKey = await phase("sender_verified", "preflight sender", () =>
      resolveVerifiedSender(client, input.sendFrom),
    );
    setLink(
      "sender_verified",
      "exercised",
      `${input.sendFrom} resolves to verified identity ${identityKey}`,
    );

    // -- provision ----------------------------------------------------------
    const tenant = await phase("provision", "createTenant", () =>
      client.createTenant({ tenantName: names.tenantName }),
    );
    cleanup.push(`delete-tenant ${names.tenantName}`, () =>
      tolerateNotFound(() =>
        client.deleteTenant({ tenantName: names.tenantName }),
      ),
    );

    await phase("provision", "createConfigurationSet", () =>
      client.createConfigurationSet({
        configurationSetName: names.configurationSetName,
      }),
    );
    cleanup.push(`delete-configuration-set ${names.configurationSetName}`, () =>
      tolerateNotFound(() =>
        client.deleteConfigurationSet({
          configurationSetName: names.configurationSetName,
        }),
      ),
    );

    const configurationSetArn = tenantScopedArn(
      tenant.arn,
      "configuration-set",
      names.configurationSetName,
    );
    await phase("provision", "associateResource:configuration-set", () =>
      client.associateResource({
        tenantName: names.tenantName,
        resourceArn: configurationSetArn,
      }),
    );
    cleanup.push(
      `disassociate-configuration-set ${names.configurationSetName}`,
      () =>
        tolerateNotFound(() =>
          client.disassociateResource({
            tenantName: names.tenantName,
            resourceArn: configurationSetArn,
          }),
        ),
    );

    // The send only succeeds if every referenced resource is associated with
    // the tenant (SendEmail's documented contract), so the operator's verified
    // identity is borrowed for the run's tenant and returned at teardown.
    const senderArn = tenantScopedArn(tenant.arn, "identity", identityKey);
    await phase("provision", "associateResource:sender-identity", () =>
      client.associateResource({
        tenantName: names.tenantName,
        resourceArn: senderArn,
      }),
    );
    cleanup.push(`disassociate-sender-identity ${identityKey}`, () =>
      tolerateNotFound(() =>
        client.disassociateResource({
          tenantName: names.tenantName,
          resourceArn: senderArn,
        }),
      ),
    );
    setLink(
      "provision",
      "exercised",
      `tenant ${names.tenantName}, configuration set, and both associations`,
    );

    // -- the verb PRD 11 could never run -------------------------------------
    await phase("put_event_destination", "putEventDestination", () =>
      client.putEventDestination({
        configurationSetName: names.configurationSetName,
        eventDestinationName: names.eventDestinationName,
        snsTopicArn: input.topicArn,
        eventTypes: WALKTHROUGH_PUBLISHED_EVENT_TYPES,
        enabled: true,
      }),
    );
    setLink(
      "put_event_destination",
      "exercised",
      `publishing ${WALKTHROUGH_PUBLISHED_EVENT_TYPES.join(", ")} to ${input.topicArn}`,
    );

    // -- the run-scoped stub stack, BEFORE anything can emit an event --------
    // Order is load-bearing: an event for an unregistered tenant records as
    // `dropped`, which is TERMINAL — registering afterwards would not recover
    // it. So the rows exist before SES is given any way to produce an event.
    stub = await phase("instance_hop", "start stub instance", () =>
      startStubInstance({ secret: input.webhookSecret }),
    );
    const startedStub = stub;
    cleanup.push("close-stub-instance", () => startedStub.close());

    // The unregister step is pushed BEFORE the inserts run, unlike every AWS
    // step: registration is four sequential non-transactional writes, so a
    // failure between them would otherwise strand the earlier rows in the
    // REAL control-plane db forever (the next run has a different runId and
    // nothing sweeps them). Pushing first is safe because the organization
    // row is written first and every other row cascades from it — the one
    // delete removes whatever subset exists, and deleting an organization
    // that was never inserted is a no-op.
    // The unregister step is pushed BEFORE the inserts run, unlike every AWS
    // step: registration is four sequential non-transactional writes, so a
    // failure between them would otherwise strand the earlier rows in the
    // REAL control-plane db forever (the next run has a different runId and
    // nothing sweeps them). Pushing first is safe because the organization
    // row is written first and every other row cascades from it — the one
    // delete removes whatever subset exists, and deleting an organization
    // that was never inserted is a no-op.
    cleanup.push(`unregister-proof-stack ${names.organizationId}`, () =>
      unregisterProofStack(db, names.organizationId),
    );
    await phase("instance_hop", "register run-scoped stack rows", () =>
      registerProofStack(db, {
        names,
        region: input.region,
        awsRegion: resolveSesRegion(input.region),
        tenantArn: tenant.arn,
        instanceUrl: startedStub.url,
        webhookSecret: input.webhookSecret,
      }),
    );
    notes.push(
      "instance hop: design call (b) — a run-scoped stack row aims the " +
        "control plane's REAL signed delivery path at a local stub that " +
        "verifies with @hogsend/plugin-hogsend's own verifier; the engine " +
        "handleWebhook → email_sends leg is reported NOT exercised rather " +
        "than faked.",
    );

    // -- subscribe the tunnel endpoint, and wait for the control plane -------
    const endpoint = `${input.publicUrl}/api/email/events/${input.region}`;
    await phase("sns_subscription", "sns:Subscribe", () =>
      sns.subscribe({ topicArn: input.topicArn, endpoint }),
    );
    let subscriptionArn: string | undefined;
    cleanup.push("unsubscribe-sns-endpoint", async () => {
      // The ARN may be unknown here (aborted while pending). A pending
      // subscription cannot be unsubscribed and SNS expires it on its own
      // after three days, so "nothing to remove" is a clean outcome.
      const found = subscriptionArn
        ? { status: "confirmed" as const, subscriptionArn }
        : await sns.findSubscription({ topicArn: input.topicArn, endpoint });
      if (found.status === "confirmed") {
        await sns.unsubscribe({ subscriptionArn: found.subscriptionArn });
      }
    });

    const subscribeWaitSeconds =
      input.subscribeWaitSeconds ?? DEFAULT_SUBSCRIBE_WAIT_SECONDS;
    await phase(
      "sns_subscription",
      "await control-plane confirmation",
      async () => {
        const deadline = now() + subscribeWaitSeconds * 1_000;
        for (;;) {
          const found = await sns.findSubscription({
            topicArn: input.topicArn,
            endpoint,
          });
          if (found.status === "confirmed") {
            subscriptionArn = found.subscriptionArn;
            return;
          }
          if (now() >= deadline) {
            throw new Error(
              `the control plane did not confirm the SNS subscription within ${subscribeWaitSeconds}s — is the tunnel forwarding to a RUNNING control plane, and does that process hold the region's topic ARN?`,
            );
          }
          await sleep(SUBSCRIBE_POLL_MS);
        }
      },
    );
    setLink(
      "sns_subscription",
      "exercised",
      `${endpoint} confirmed as ${subscriptionArn ?? "<unknown>"}`,
    );

    // -- the sends -----------------------------------------------------------
    const expected: ExpectedEvent[] = [];
    const record = (scenario: ProofScenario, messageId: string): void => {
      expected.push({
        scenario,
        recipient: recipients[scenario],
        messageId,
        expectedType: EXPECTED_TYPE_BY_SCENARIO[scenario],
      });
    };

    const sent = await phase(
      "send_email",
      `sendEmail success → ${recipients.success}`,
      () =>
        client.sendEmail({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          message: proofMessage(
            input.sendFrom,
            recipients.success,
            names.runId,
          ),
        }),
    );
    record("success", sent.messageId);

    const bounced = await phase(
      "send_email",
      `sendEmail bounce → ${recipients.bounce}`,
      () =>
        client.sendEmail({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          message: proofMessage(input.sendFrom, recipients.bounce, names.runId),
        }),
    );
    record("bounce", bounced.messageId);
    setLink(
      "send_email",
      "exercised",
      `2 messages accepted (${sent.messageId}, ${bounced.messageId})`,
    );

    // The complaint rides `sendBatch`, so the batch verb is proven too without
    // doubling any scenario's event volume.
    const batch = await phase(
      "send_batch",
      `sendBatch complaint → ${recipients.complaint}`,
      async () => {
        const result = await client.sendBatch({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          messages: [
            proofMessage(input.sendFrom, recipients.complaint, names.runId),
          ],
        });
        const entry = result.results[0];
        if (!entry || entry.status !== "sent") {
          throw new Error(
            `the batch entry did not send: ${
              entry ? `${entry.kind} — ${entry.message}` : "no result returned"
            }`,
          );
        }
        return entry;
      },
    );
    record("complaint", batch.messageId);
    setLink(
      "send_batch",
      "exercised",
      `1-message batch accepted (${batch.messageId})`,
    );

    // -- observe -------------------------------------------------------------
    out(
      `▶ waiting up to ${input.observeSeconds}s for ${expected.length} events to travel SES → SNS → ${endpoint} → email_events`,
    );
    events = await phase(null, "observe email_events", () =>
      observeEmailEvents({
        db,
        expected,
        deadlineMs: input.observeSeconds * 1_000,
        sleep,
        now,
      }),
    );
    for (const event of events) {
      const link = EVENT_LINK_BY_SCENARIO[event.scenario];
      if (!event.arrived) {
        setLink(
          link,
          "failed",
          `no email_events row for message ${event.messageId} (${event.recipient}) within ${input.observeSeconds}s`,
        );
      } else if (!event.typeMatches) {
        setLink(
          link,
          "failed",
          `normalized to ${event.type ?? "<none>"}, expected ${event.expectedType}`,
        );
      } else {
        setLink(
          link,
          "exercised",
          `normalized ${event.type}; row status ${event.status} after ${event.attempts ?? 0} attempt(s)${
            event.lastError ? ` (last error: ${event.lastError})` : ""
          }`,
        );
      }
    }

    // -- the signed hop, judged from both ends -------------------------------
    const arrived = events.filter((event) => event.arrived);
    const undelivered = arrived.filter((event) => event.status !== "delivered");
    const signatureFailures = startedStub.received.filter(
      (receipt) => !receipt.signatureValid,
    ).length;
    if (arrived.length === 0) {
      setLink(
        "instance_hop",
        "not_exercised",
        "no event reached the ingress, so the hop never fired",
      );
    } else if (undelivered.length > 0 || signatureFailures > 0) {
      setLink(
        "instance_hop",
        "failed",
        `${undelivered.length} event(s) did not settle "delivered"${
          signatureFailures > 0
            ? `; ${signatureFailures} signature failure(s) at the stub`
            : ""
        }`,
      );
    } else {
      setLink(
        "instance_hop",
        "exercised",
        `${startedStub.received.length} signed deliveries, every signature verified by @hogsend/plugin-hogsend's own verifier (run-scoped stub stack)`,
      );
    }

    // -- the suppression probe -----------------------------------------------
    // A suppressed re-send is ACCEPTED, not refused: AWS documents that SES
    // "accepts the message, but doesn't send it" when the address is on the
    // applicable suppression list, so `sendEmail` returning a message id
    // proves NOTHING either way. The one observable that answers the question
    // is the probe's OWN Bounce event: the simulator's real bounce arrives
    // Permanent/General, while every suppression outcome arrives with a
    // suppression-named subtype (`Suppressed`, `OnAccountSuppressionList`,
    // `OnTenantSuppressionList`, `EmailValidationSuppressed` — the SNS event
    // publishing contents table). Which list applies: a tenant defaults to
    // ACCOUNT scope and THIS run's tenant never calls `putSuppressionScope`,
    // so the account-level list governs the probe — but production tenants
    // opt into TENANT scope (`services/ses-tenants.ts`), where SES uses the
    // tenant's list INSTEAD. Judging by the bounce subtype is correct under
    // either scope; reading one list via `GetSuppressedDestination` would
    // not be, which is why no read verb (and no new IAM grant) exists here.
    let probe: { messageId: string } | undefined;
    try {
      probe = await client.sendEmail({
        tenantName: names.tenantName,
        configurationSetName: names.configurationSetName,
        message: proofMessage(input.sendFrom, recipients.bounce, names.runId),
      });
      probeMessageId = probe.messageId;
      steps.push({ label: "suppression probe re-send", status: "ok" });
    } catch (error) {
      const detail = errorMessage(error);
      steps.push({
        label: "suppression probe re-send",
        status: "failed",
        detail,
      });
      setLink("suppression_check", "failed", detail);
      // ONLY a suppression-shaped refusal is the finding. Anything else — a
      // TooManyRequests on the 4th send of a burst is the PRD-warned case —
      // is a failed step, and blaming suppression logic that never ran would
      // be exactly the false report this script exists not to produce.
      if (/suppress/i.test(detail)) {
        findings.push(
          `the probe re-send to ${recipients.bounce} was REFUSED with a suppression-shaped error — AWS documents that address as NOT added to the suppression list, so this is suppression acting on a documented-safe recipient: ${detail}`,
        );
      }
    }
    if (probe) {
      const accepted = probe;
      try {
        const [probeEvent] = await observeEmailEvents({
          db,
          expected: [
            {
              scenario: "bounce",
              recipient: recipients.bounce,
              messageId: accepted.messageId,
              expectedType: EXPECTED_TYPE_BY_SCENARIO.bounce,
            },
          ],
          deadlineMs: input.observeSeconds * 1_000,
          sleep,
          now,
        });
        if (!probeEvent?.arrived || !probeEvent.typeMatches) {
          setLink(
            "suppression_check",
            "failed",
            `probe re-send accepted (${accepted.messageId}) but its Bounce event ${
              probeEvent?.arrived
                ? `normalized to ${probeEvent.type ?? "<none>"}, not email.bounced`
                : `did not arrive within ${input.observeSeconds}s`
            } — SES accepts a suppressed send too, so acceptance alone proves nothing and the question is UNANSWERED`,
          );
          notes.push(
            "the probe's bounce was not observed before teardown; if it " +
              "lands afterwards it records as an inert dropped row.",
          );
        } else if (isSuppressedBounce(probeEvent.bounceSubType)) {
          setLink(
            "suppression_check",
            "failed",
            `probe re-send accepted (${accepted.messageId}) and then bounced ${probeEvent.bounceSubType} — a suppression list acted`,
          );
          findings.push(
            `the probe re-send to ${recipients.bounce} was accepted (${accepted.messageId}) and then SUPPRESSED: its bounce subtype is ${probeEvent.bounceSubType}, which names the suppression list that acted — AWS documents the simulator bounce address as NOT added to the suppression list, so this is suppression acting on a documented-safe recipient`,
          );
        } else {
          setLink(
            "suppression_check",
            "exercised",
            `probe re-send (${accepted.messageId}) bounced ${
              probeEvent.bounceSubType ?? "<no subtype>"
            } — a suppressed send bounces with a suppression-named subtype, so the bounce address was NOT suppressed`,
          );
        }
      } catch (error) {
        // The probe must never abort the run — an unanswerable probe is a
        // failed link in the report, which is the point.
        const detail = errorMessage(error);
        steps.push({ label: "observe probe bounce", status: "failed", detail });
        setLink(
          "suppression_check",
          "failed",
          `probe re-send accepted (${accepted.messageId}) but observing its bounce failed: ${detail}`,
        );
      }
    }
  } catch (error) {
    aborted = error instanceof ProofAbort ? error.message : errorMessage(error);
  }

  return finish();
}

/**
 * `--send-from` may name an ADDRESS identity or an address under a DOMAIN
 * identity — SES resolves a send's identity either way, so the preflight
 * mirrors that: the address first, then its domain. Returns whichever key the
 * account actually holds VERIFIED; refuses otherwise, creating nothing.
 */
async function resolveVerifiedSender(
  client: SesClient,
  sendFrom: string,
): Promise<string> {
  const candidates = [sendFrom, domainOfAddress(sendFrom)];
  for (const candidate of candidates) {
    let identity: Awaited<ReturnType<SesClient["getIdentity"]>>;
    try {
      identity = await client.getIdentity({ identity: candidate });
    } catch (error) {
      if (error instanceof SesError && error.kind === "not_found") continue;
      throw error;
    }
    if (identity.verifiedForSending) return candidate;
    throw new Error(
      `refusing to send: identity ${candidate} exists but is not verified for sending (status ${identity.verificationStatus}) — the verification email may still be UNCLICKED, or the domain's DKIM records may not have propagated. Nothing was created.`,
    );
  }
  throw new Error(
    `refusing to send: neither ${sendFrom} nor ${domainOfAddress(sendFrom)} is a verified identity in this account — create the identity and complete verification first. Nothing was created.`,
  );
}

function proofMessage(from: string, to: string, runId: string): SesMessage {
  return {
    from,
    to: [to],
    subject: `Hogsend SES delivery proof ${runId}`,
    text: `Delivery proof ${runId}. This message exists only to make the SES mailbox simulator emit an event; nobody reads it.`,
  };
}

/**
 * Whether a bounce subtype names a suppression list. Every suppression
 * outcome AWS documents — `Suppressed` (global list),
 * `OnAccountSuppressionList`, `OnTenantSuppressionList`,
 * `EmailValidationSuppressed` — carries the word in its subtype, and a real
 * simulator bounce is `General`. Matched by substring rather than a closed
 * list so a future suppression subtype classifies as the finding it is
 * instead of as a clean pass.
 */
function isSuppressedBounce(subType: string | null): boolean {
  return subType !== null && /suppress/i.test(subType);
}

/**
 * Swallow exactly `not_found` in a teardown — a resource already gone is the
 * teardown's goal, not an error. Everything else propagates so the cleanup
 * report names it. (Mirrors the walkthrough's private `tolerate`.)
 */
async function tolerateNotFound(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SesError && error.kind === "not_found") return;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
