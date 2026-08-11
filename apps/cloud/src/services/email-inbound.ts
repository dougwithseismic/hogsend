import { and, eq, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  emailEvents,
  emailIdempotency,
  emailInboundMessages,
  sesTenants,
  stacks,
} from "../db/schema";
import { decryptSecretPayload } from "../lib/crypto";
import type { ParsedInboundMessage } from "../lib/inbound-mime";
import { autoResponderReason, parseInboundMime } from "../lib/inbound-mime";
import type { SesInboundNotification } from "../lib/ses-inbound-notifications";
import { readStackRefs } from "../lib/stack-refs";
import type { SubstrateRegion } from "../substrate/types";
import { instanceWebhookUrl, postToInstance } from "./email-events";
import type {
  InboundObject,
  InboundObjectFetcher,
} from "./email-inbound-objects";
import {
  fetchInboundObject,
  InboundObjectTooLargeError,
  MAX_INBOUND_OBJECT_BYTES,
} from "./email-inbound-objects";
import { findInboundRecipientOwner } from "./ses-inbound-config";

/**
 * A RECEIVED MESSAGE -> a durable record, then an event (PRD 16 task 4).
 *
 * Everything here happens AFTER the SNS signature has been verified. The order
 * is the whole design, and each step is where it is because the step after it
 * is expensive, irreversible, or hostile:
 *
 *   resolve recipient -> RECORD -> fetch (bounded) -> parse -> correlate
 *     -> update -> suppress? -> deliver -> settle
 *
 *  - **the recipient decides the tenant, and nothing else may.** SES matched a
 *    receipt rule on the SMTP envelope recipient and stated it inside a signed
 *    notification. Every header in the message itself was written by whoever
 *    sent it, so `To:`, `From:` and `In-Reply-To` are evidence of nothing;
 *  - **RECORD BEFORE ANYTHING ELSE.** PRD 16: "the failure that matters is a
 *    reply we accepted and then lost". SES has already written the raw MIME to
 *    S3, so the durable copy exists; what does not exist until this insert is
 *    any record that it is OURS to act on. The insert is also the dedupe, by
 *    unique violation rather than check-then-insert, because SNS is
 *    at-least-once and a duplicate `email.replied` can exit a journey twice;
 *  - **the fetch is bounded before it is made** (see
 *    `email-inbound-objects.ts`), and an oversized message is a SUPPRESSION,
 *    not a loss: the record and the S3 reference stand, the forward still has
 *    everything it needs, and only the event is skipped;
 *  - **correlation is scoped to the environment the RECIPIENT resolved to.**
 *    See {@link correlateToEnvironment} - this is the tenant boundary, and it
 *    is the only reason a forged `In-Reply-To` is harmless;
 *  - **an auto-responder is stored and never emitted.** Emitting would let two
 *    machines answer each other indefinitely. See `autoResponderReason`.
 *
 * The status codes the caller derives from the outcome are chosen for what they
 * make SNS DO, exactly as the status-event ingress does: a 200 stops the
 * retry, a non-2xx asks for a redelivery, and the row's attempt ceiling is what
 * stops "ask again" being forever.
 */

/** Attempts inside ONE request. Small: SNS times an HTTP endpoint out. */
export const EMAIL_INBOUND_ATTEMPTS_PER_REQUEST = 3;

/**
 * The hard ceiling across every SNS redelivery of one received message.
 *
 * The same nine the status wire uses, and for the same reason: three real
 * chances at an instance that is briefly down (a deploy, a restart) before we
 * stop. Exhausting it leaves a `failed` row carrying the last error - the
 * message itself is still in S3 and still referenced, so nothing is lost that
 * an operator cannot re-drive.
 */
export const EMAIL_INBOUND_MAX_ATTEMPTS = 9;

/** The wire's schema version. Bumped only on a BREAKING change to the shape. */
export const HOGSEND_RELAY_INBOUND_EVENT_VERSION = 1;

/** The one event this wire carries. */
export const HOGSEND_RELAY_INBOUND_EVENT_TYPE = "email.replied";

/**
 * What the tenant instance receives.
 *
 * Declared HERE rather than in `@hogsend/plugin-hogsend` for now because the
 * engine half of this wire is PRD 16 task 5, and this task's boundary is
 * `apps/cloud`. When task 5 lands, this shape moves next to
 * `HogsendRelayEmailEvent` and both ends import one declaration - the same rule
 * the status wire already follows, for the same reason (a literal duplicated
 * across a wire drifts, and the drift shows up as silently dropped replies).
 *
 * Three things it deliberately does NOT carry:
 *
 *  - **no attachment bytes**, only a manifest. The PRD's line is "store,
 *    reference, and let the customer opt in to retrieval", and `storage` is
 *    that reference;
 *  - **no HTML.** A tenant instance stores what it is sent and a Studio renders
 *    it later; handing it an attacker's markup is a stored-XSS surface we can
 *    simply decline to create;
 *  - **no unverified `inReplyTo`.** The field is present ONLY when the control
 *    plane proved the id belongs to a send this same environment made, so the
 *    engine can key on it without re-deciding the tenant question.
 */
export interface HogsendRelayInboundEvent {
  version: number;
  type: typeof HOGSEND_RELAY_INBOUND_EVENT_TYPE;
  /** SES's id for the RECEIVED message. Not the message being replied to. */
  messageId: string;
  /** The envelope recipient that resolved to this environment. */
  recipient: string;
  /** Every envelope recipient SES matched, in SES's order. */
  recipients: string[];
  from: string | null;
  subject: string | null;
  /** Bounded plain text. See `MAX_INBOUND_TEXT_CHARS`. */
  text: string | null;
  textTruncated: boolean;
  occurredAt: string;
  /** True only when {@link inReplyTo} is set and proven. */
  correlated: boolean;
  /** PROVEN to be a send this environment made, or absent. */
  inReplyTo?: string;
  attachments: { filename: string | null; contentType: string; size: number }[];
  attachmentsTruncated: boolean;
  /** SES's scan verdicts, verbatim. Nothing here classifies them. */
  spamVerdict: string | null;
  virusVerdict: string | null;
  /** Where the raw MIME lives, so a customer can opt in to retrieving it. */
  storage: { bucket: string; key: string; size: number | null };
}

export type InboundOutcome =
  | { status: "delivered"; messageId: string; attempts: number }
  /** Already seen. The at-least-once collapse; nothing was delivered again. */
  | { status: "duplicate"; messageId: string }
  /** Stored, referenced, and deliberately not emitted. NOT a failure. */
  | { status: "suppressed"; messageId: string; reason: InboundSuppression }
  /** Terminal and not a failure: there was nobody this belonged to. */
  | { status: "dropped"; messageId: string; reason: "unresolved_recipient" }
  | {
      status: "failed";
      messageId: string;
      attempts: number;
      exhausted: boolean;
      error: string;
    };

/** Why a stored message produced no event. */
export type InboundSuppression =
  | "auto_submitted"
  | "precedence_bulk"
  | "too_large"
  | "unparseable";

export interface EmailInboundDeps {
  db?: CloudDb;
  /** The S3 read seam. Injected so no test reaches AWS. */
  fetchObject?: InboundObjectFetcher;
  /** The outbound instance hop. Injected so no test reaches a tenant. */
  fetchImpl?: typeof fetch;
  /** Injected so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
  /** Overridable so a test can prove the cap without a 10 MiB fixture. */
  maxObjectBytes?: number;
}

/**
 * Record one received message and hand it to its tenant's instance.
 *
 * Safe to call repeatedly with the same notification: the second call
 * short-circuits on the unique index unless the first one left the row
 * retryable.
 */
export async function ingestInboundMessage(
  input: { region: SubstrateRegion; notification: SesInboundNotification },
  deps: EmailInboundDeps = {},
): Promise<InboundOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const { notification, region } = input;

  // (1) WHOSE is this? The envelope recipient, and nothing the sender wrote.
  const owner = await firstOwner(notification.recipients, db);

  // (2) RECORD. Before the S3 read, before the parse, before any hop. The
  // insert is also the dedupe: `onConflictDoNothing` returns no row for a
  // redelivery, which is the database serialising the decision rather than the
  // application reading and then writing.
  const [inserted] = await db
    .insert(emailInboundMessages)
    .values({
      environmentId: owner?.environmentId ?? null,
      region,
      dedupeKey: notification.dedupeKey,
      sesMessageId: notification.sesMessageId,
      recipient: owner?.recipient ?? notification.recipients[0] ?? "",
      recipients: notification.recipients,
      domain: owner?.domain ?? null,
      bucket: notification.bucket,
      objectKey: notification.objectKey,
      status: "pending",
      receivedAt: new Date(notification.receivedAt),
    })
    .onConflictDoNothing({ target: emailInboundMessages.dedupeKey })
    .returning({ id: emailInboundMessages.id });

  const existing = inserted
    ? null
    : await findByDedupeKey(db, notification.dedupeKey);

  // Seen before AND already settled. Deliberately no second delivery: a
  // duplicate `email.replied` can exit a journey a second time, and an exit is
  // not a thing we can take back.
  if (existing && !isRetryable(existing)) {
    return { status: "duplicate", messageId: existing.id };
  }

  const rowId = inserted?.id ?? existing?.id;
  if (!rowId) {
    // A row that vanished between the conflict and the read. Nothing sane to do
    // but treat it as handled; the next redelivery re-inserts it.
    return { status: "duplicate", messageId: "unknown" };
  }
  const attemptsSoFar = existing?.attempts ?? 0;

  // (3) Nobody's. Recorded and terminal: an unknown recipient does not become
  // known by waiting, there is no forwarding address for it, and broadcasting
  // is never the answer. No S3 read is spent on it either.
  if (!owner) {
    await settle(db, rowId, {
      status: "dropped",
      reason: "unresolved_recipient",
      attempts: attemptsSoFar,
      lastError: `no environment receives for ${JSON.stringify(
        notification.recipients.join(", "),
      )}`,
      now,
    });
    return {
      status: "dropped",
      messageId: rowId,
      reason: "unresolved_recipient",
    };
  }

  // (4) READ, bounded. See `email-inbound-objects.ts` for both bounds.
  const fetchObject = deps.fetchObject ?? fetchInboundObject;
  let object: InboundObject;
  try {
    object = await fetchObject({
      bucket: notification.bucket,
      key: notification.objectKey,
      region,
      maxBytes: deps.maxObjectBytes ?? MAX_INBOUND_OBJECT_BYTES,
    });
  } catch (error) {
    if (error instanceof InboundObjectTooLargeError) {
      // STORED, REFERENCED, NOT EMITTED. The record keeps the size so an
      // operator can see why, and the forward (task 6) streams from S3 and is
      // unaffected by a limit that exists only to bound THIS process.
      await settle(db, rowId, {
        status: "suppressed",
        reason: "too_large",
        attempts: attemptsSoFar,
        sizeBytes: error.size,
        now,
      });
      return { status: "suppressed", messageId: rowId, reason: "too_large" };
    }
    // Anything else is "we could not read it", which is transient until proven
    // otherwise: the object is in S3 and SNS will come back.
    return failed(db, rowId, {
      attempts: attemptsSoFar + 1,
      error: error instanceof Error ? error.message : String(error),
      now,
    });
  }

  // (5) PARSE. Hostile bytes; everything that comes back is bounded.
  let parsed: ParsedInboundMessage;
  try {
    parsed = await parseInboundMime(object.body);
  } catch (error) {
    // A parse that threw once throws again on identical bytes, so retrying is
    // the "never retry a 4xx" mistake pointed at our own parser. Stored,
    // referenced, forwardable, no event.
    await settle(db, rowId, {
      status: "suppressed",
      reason: "unparseable",
      attempts: attemptsSoFar,
      sizeBytes: object.size,
      lastError: error instanceof Error ? error.message : String(error),
      now,
    });
    return { status: "suppressed", messageId: rowId, reason: "unparseable" };
  }

  // (6) CORRELATE, scoped to the environment the recipient resolved to.
  const correlatedMessageId = await correlateToEnvironment(db, {
    environmentId: owner.environmentId,
    candidates: parsed.correlationCandidates,
  });

  // (7) The parsed facts are durable BEFORE the event that reports them.
  await db
    .update(emailInboundMessages)
    .set({
      sizeBytes: object.size,
      fromAddress: parsed.from,
      subject: parsed.subject,
      inReplyTo: parsed.inReplyTo,
      correlatedMessageId,
      correlated: correlatedMessageId !== null,
      attachments: parsed.attachments,
      updatedAt: now,
    })
    .where(eq(emailInboundMessages.id, rowId));

  // (8) The loop guard. Stored above, emitted never.
  const suppression = autoResponderReason(parsed);
  if (suppression) {
    await settle(db, rowId, {
      status: "suppressed",
      reason: suppression,
      attempts: attemptsSoFar,
      now,
    });
    return { status: "suppressed", messageId: rowId, reason: suppression };
  }

  // (9) A stack mid-provision has no public URL yet. TRANSIENT, and a lost
  // reply is permanent, so it is a retryable failure rather than a drop. The
  // counter still ticks even though no request was made, or a stack that never
  // finishes provisioning would re-drive forever.
  const target = await resolveInstance(db, owner.environmentId);
  if (!target?.apiPublicUrl) {
    return failed(db, rowId, {
      attempts: attemptsSoFar + 1,
      error: target
        ? "the environment's instance has no public URL yet"
        : "the environment has no SES tenancy, so no webhook secret exists",
      now,
    });
  }

  const event = buildInboundEvent({
    notification,
    owner,
    parsed,
    object,
    correlatedMessageId,
  });

  const budget = Math.max(
    0,
    Math.min(
      EMAIL_INBOUND_ATTEMPTS_PER_REQUEST,
      EMAIL_INBOUND_MAX_ATTEMPTS - attemptsSoFar,
    ),
  );
  const result = await postToInstance({
    url: instanceWebhookUrl(target.apiPublicUrl),
    // The bytes we sign are the bytes we send: the instance verifies over the
    // EXACT received body, so re-serializing anywhere between here and the wire
    // would break every signature.
    payload: JSON.stringify(event),
    secret: target.webhookSecret,
    attempts: budget,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });

  const attempts = attemptsSoFar + result.attempts;
  if (result.ok) {
    await settle(db, rowId, { status: "delivered", attempts, now });
    return { status: "delivered", messageId: rowId, attempts };
  }
  return failed(db, rowId, { attempts, error: result.error, now });
}

/**
 * The event, built only from values that have been bounded or proven.
 *
 * `inReplyTo` is present ONLY when correlation succeeded. That is the single
 * most important line in this file: the sender's claimed `In-Reply-To` is
 * recorded on the ROW (unverified, for support) and never reaches the instance
 * unless this control plane matched it against a send THIS environment made.
 */
export function buildInboundEvent(input: {
  notification: SesInboundNotification;
  owner: { recipient: string };
  parsed: ParsedInboundMessage;
  object: { size: number };
  correlatedMessageId: string | null;
}): HogsendRelayInboundEvent {
  const { notification, parsed, correlatedMessageId } = input;
  return {
    version: HOGSEND_RELAY_INBOUND_EVENT_VERSION,
    type: HOGSEND_RELAY_INBOUND_EVENT_TYPE,
    messageId: notification.sesMessageId,
    recipient: input.owner.recipient,
    recipients: notification.recipients,
    from: parsed.from,
    subject: parsed.subject,
    text: parsed.text,
    textTruncated: parsed.textTruncated,
    occurredAt: notification.receivedAt,
    correlated: correlatedMessageId !== null,
    ...(correlatedMessageId ? { inReplyTo: correlatedMessageId } : {}),
    attachments: parsed.attachments,
    attachmentsTruncated: parsed.attachmentsTruncated,
    spamVerdict: notification.spamVerdict,
    virusVerdict: notification.virusVerdict,
    storage: {
      bucket: notification.bucket,
      key: notification.objectKey,
      size: input.object.size,
    },
  };
}

/**
 * THE FORGED-HEADER DEFENCE.
 *
 * `In-Reply-To` and `References` are written by whoever sent the message.
 * Anybody can put `<0100-a-tenants-real-send@eu-west-1.amazonses.com>` in a
 * reply to `reply.attacker-owned.com` and, in a system that trusted the header,
 * attach their message to a stranger's journey and a stranger's contact.
 *
 * So the claim is never used as an identifier - it is used as a QUESTION, asked
 * of one environment: *did YOU send this message id?* The environment is the one
 * the envelope recipient resolved to, which SES asserted inside a
 * signature-verified notification, so the answer cannot be influenced by
 * anything in the message. A stranger's id is simply not in this environment's
 * rows, the answer is `null`, and the reply is delivered UNCORRELATED rather
 * than being attached to somebody else's send or dropped.
 *
 * Two tables, because one alone would be a silent hole:
 *  - `email_idempotency` holds every message the relay accepted, but is pruned
 *    at `EMAIL_IDEMPOTENCY_RETENTION_MS` (7 days);
 *  - `email_events` holds every message a status arrived for, and is not.
 * A reply to a three-week-old email correlates through the second. A reply to a
 * send that has had no status event yet correlates through the first.
 *
 * Both queries are scoped by `environment_id` FIRST, which is also how the
 * indexes are ordered, so the tenant scope is part of the access path and not a
 * filter somebody could drop while "optimising" the query.
 */
export async function correlateToEnvironment(
  db: CloudDb,
  input: { environmentId: string; candidates: string[] },
): Promise<string | null> {
  const keys = lookupKeys(input.candidates);
  if (keys.length === 0) return null;

  const [claimed] = await db
    .select({ messageId: emailIdempotency.messageId })
    .from(emailIdempotency)
    .where(
      and(
        eq(emailIdempotency.environmentId, input.environmentId),
        inArray(emailIdempotency.messageId, keys),
      ),
    )
    .limit(1);
  if (claimed?.messageId) return claimed.messageId;

  const [evented] = await db
    .select({ messageId: emailEvents.messageId })
    .from(emailEvents)
    .where(
      and(
        eq(emailEvents.environmentId, input.environmentId),
        inArray(emailEvents.messageId, keys),
      ),
    )
    .limit(1);
  return evented?.messageId ?? null;
}

/**
 * The strings to test, from the message ids the sender claimed.
 *
 * SES stamps its own `Message-ID` on a message it sends as
 * `<{MessageId}@{region}.amazonses.com>`, so the id we RECORDED at send time is
 * the local part of what comes back in `In-Reply-To`. Both forms are tested,
 * because a customer supplying their own `Message-ID` produces neither and a
 * relaying agent occasionally strips the domain.
 */
function lookupKeys(candidates: string[]): string[] {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    keys.add(candidate);
    const at = candidate.indexOf("@");
    if (at > 0) keys.add(candidate.slice(0, at));
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type InboundRow = typeof emailInboundMessages.$inferSelect;

interface ResolvedOwner {
  environmentId: string;
  domain: string;
  recipient: string;
}

/**
 * The first envelope recipient that belongs to somebody.
 *
 * SES can match one message against several recipients (a `To:` and a `Cc:`
 * both under our rules). One message becomes one record, so the FIRST resolved
 * recipient owns it - splitting one physical message into two tenants' events
 * would emit the same human's words twice.
 */
async function firstOwner(
  recipients: string[],
  db: CloudDb,
): Promise<ResolvedOwner | null> {
  for (const recipient of recipients) {
    const owner = await findInboundRecipientOwner(recipient, { db });
    if (owner) {
      return {
        environmentId: owner.environmentId,
        domain: owner.domain,
        recipient,
      };
    }
  }
  return null;
}

interface InstanceTarget {
  webhookSecret: string;
  apiPublicUrl: string | null;
}

/** The environment's instance URL and the secret its webhooks are signed with. */
async function resolveInstance(
  db: CloudDb,
  environmentId: string,
): Promise<InstanceTarget | null> {
  const [row] = await db
    .select({
      webhookSecretEncrypted: sesTenants.webhookSecretEncrypted,
      substrateRefs: stacks.substrateRefs,
    })
    .from(sesTenants)
    .leftJoin(stacks, eq(stacks.environmentId, sesTenants.environmentId))
    .where(eq(sesTenants.environmentId, environmentId))
    .limit(1);
  if (!row) return null;

  return {
    webhookSecret: decryptSecretPayload<string>(row.webhookSecretEncrypted),
    apiPublicUrl: row.substrateRefs
      ? (readStackRefs({ substrateRefs: row.substrateRefs })?.apiPublicUrl ??
        null)
      : null,
  };
}

async function findByDedupeKey(
  db: CloudDb,
  dedupeKey: string,
): Promise<InboundRow | undefined> {
  const [row] = await db
    .select()
    .from(emailInboundMessages)
    .where(eq(emailInboundMessages.dedupeKey, dedupeKey))
    .limit(1);
  return row;
}

/**
 * Whether a row we have seen before may be attempted again.
 *
 * Only a `failed` row under the ceiling. `delivered`, `dropped` and
 * `suppressed` are TERMINAL - re-running a suppressed message would re-decide
 * a loop guard that already said no - and `pending` means another request is at
 * the wire right now.
 */
function isRetryable(row: InboundRow): boolean {
  return row.status === "failed" && row.attempts < EMAIL_INBOUND_MAX_ATTEMPTS;
}

async function failed(
  db: CloudDb,
  rowId: string,
  input: { attempts: number; error: string; now: Date },
): Promise<InboundOutcome> {
  const exhausted = input.attempts >= EMAIL_INBOUND_MAX_ATTEMPTS;
  await settle(db, rowId, {
    status: "failed",
    attempts: input.attempts,
    lastError: input.error,
    now: input.now,
  });
  return {
    status: "failed",
    messageId: rowId,
    attempts: input.attempts,
    exhausted,
    error: input.error,
  };
}

async function settle(
  db: CloudDb,
  rowId: string,
  input: {
    status: InboundRow["status"];
    reason?: InboundRow["reason"];
    attempts: number;
    lastError?: string;
    sizeBytes?: number;
    now: Date;
  },
): Promise<void> {
  await db
    .update(emailInboundMessages)
    .set({
      status: input.status,
      reason: input.reason ?? null,
      attempts: input.attempts,
      lastError: input.lastError ?? null,
      deliveredAt: input.status === "delivered" ? input.now : null,
      ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(emailInboundMessages.id, rowId),
        // Never walk a terminal row backwards: a slow request finishing after a
        // redelivery already settled the row must not un-deliver it.
        sql`${emailInboundMessages.status} <> 'delivered'`,
      ),
    );
}
