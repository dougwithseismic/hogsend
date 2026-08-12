import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  signHogsendRelayWebhook,
} from "@hogsend/plugin-hogsend";
import { and, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailEvents, sesTenants, stacks } from "../db/schema";
import { decryptSecretPayload } from "../lib/crypto";
import type { NormalizedSesEvent } from "../lib/ses-events";
import { readStackRefs } from "../lib/stack-refs";
import type { SubstrateRegion } from "../substrate/types";

/**
 * SES EVENT → TENANT INSTANCE (PRD 05 tasks 4 and 5).
 *
 * Everything here happens AFTER the SNS signature has been verified. The order
 * is load-bearing:
 *
 *   record (dedupe) → resolve tenant → deliver (bounded) → record the outcome
 *
 *  - **record first**, so an event that later fails to deliver still exists.
 *    An event we received and then lost is invisible; an event we received and
 *    recorded is a row an operator can find;
 *  - **the INSERT is the dedupe**, by unique violation rather than by
 *    check-then-insert, exactly as `email_idempotency` does it. SNS delivers at
 *    least once and the engine's `handleWebhook` has no dedupe of its own —
 *    read, not assumed: it re-emits outbound events and increments a contact's
 *    bounce counter toward the suppression threshold on every call, so a
 *    duplicate bounce can suppress a deliverable address;
 *  - **resolve by the SES tenant name**, against the `ses_tenants` row that
 *    minted it. An event whose tenant resolves to nothing is DROPPED, never
 *    broadcast: one tenant's bounce suppressing another tenant's contact is the
 *    cross-tenant leak this stack exists to avoid;
 *  - **retry is bounded twice over.** Three attempts inside one request, and a
 *    hard ceiling on the row across SNS's own redeliveries. Past the ceiling
 *    the row is terminal and the endpoint stops asking SNS to come back.
 */

/** Attempts inside ONE request. Small: SNS times an HTTP endpoint out. */
export const EMAIL_EVENT_ATTEMPTS_PER_REQUEST = 3;

/**
 * The hard ceiling across every SNS redelivery of one event.
 *
 * Three per request and nine in total means SNS's own retry policy — which
 * re-drives a failed HTTP delivery for days — gets three real chances at an
 * instance that is briefly down (a deploy, a restart) before we call it. Past
 * this the row stays `failed` and nothing further is attempted, which is the
 * "never retry forever" line.
 *
 * **The instance's replay window is the real outer bound, and it is shorter
 * than SNS's retry policy.** `plugin-hogsend` refuses a payload whose
 * `occurredAt` is more than `HOGSEND_RELAY_MAX_AGE_MS` (24 hours) old, so an
 * instance unreachable for longer than that will answer 401 rather than
 * accept a late event. That composes correctly rather than thrashing: a 401 is
 * a 4xx, `postToInstance` never retries a 4xx, and the row settles `failed`
 * with the reason on it. It is a deliberate trade — a bounce a day late is
 * worth less than an unbounded replay window — and it is written here so the
 * two limits are visible together rather than surprising somebody at 3am.
 */
export const EMAIL_EVENT_MAX_ATTEMPTS = 9;

/**
 * How long a `pending` row may sit untouched before a redelivery may claim it
 * as ABANDONED — the process died between the insert and `settle` (a redeploy,
 * an OOM, SNS timing the request out), so nobody is coming back for it.
 *
 * Sized against the WORST-CASE LIVE REQUEST, not against SNS. The longest a
 * live request can hold `pending` is bounded and small:
 * {@link EMAIL_EVENT_ATTEMPTS_PER_REQUEST} POSTs of at most 5 seconds each
 * plus 1.25 seconds of in-request backoff — under twenty seconds — plus
 * single-digit-second DB work around them. Sixty seconds is ~3× that bound,
 * with the rest of the margin absorbing clock skew between control-plane
 * instances (the cutoff compares THIS process's clock against a timestamp
 * another instance wrote).
 *
 * The window can afford to be tight because a redelivery arriving INSIDE it is
 * answered `in_flight` → HTTP 503, which keeps SNS's own retry schedule — the
 * durable one — alive. The window therefore only ever DELAYS recovery; it
 * never forfeits it. Without that non-2xx a row abandoned mid-flight answered
 * `duplicate` → 200 on the retry SNS sends within seconds, SNS stopped for
 * good, and the bounce was lost — a suppression that never happens.
 */
export const EMAIL_EVENT_PENDING_CLAIM_MS = 60 * 1000;

/** Backoff between in-request attempts. Bounded so the whole request fits
 * comfortably inside SNS's delivery timeout. */
const RETRY_BACKOFF_MS = [250, 1_000];

/** Per-attempt ceiling on the outbound POST. */
const DELIVERY_TIMEOUT_MS = 5_000;

/** The engine route the relay's own `EmailProvider` is registered on. */
export function instanceWebhookUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, "")}/v1/webhooks/email/hogsend`;
}

export type EmailEventOutcome =
  | { status: "delivered"; eventId: string; attempts: number }
  /** Already seen AND settled. The at-least-once collapse; nothing was
   * delivered again, and nothing ever will be. A FINAL answer (HTTP 200). */
  | { status: "duplicate"; eventId: string }
  /** Seen and NOT settled, but not claimable right now — a concurrent request
   * may be at the wire. A TEMPORARY answer: the ingress maps it to a non-2xx
   * so SNS retries, and that retry finds the row either settled (→ duplicate)
   * or abandoned and old enough to claim (→ delivered). Answering 200 here
   * would stop SNS forever while settling nothing, orphaning the row. */
  | { status: "in_flight"; eventId: string }
  /** Terminal and NOT a failure: there was nobody to deliver this to. */
  | { status: "dropped"; eventId: string; reason: string }
  | {
      status: "failed";
      eventId: string;
      attempts: number;
      /** True once the row hit {@link EMAIL_EVENT_MAX_ATTEMPTS}. */
      exhausted: boolean;
      error: string;
    };

export interface EmailEventDeps {
  db?: CloudDb;
  /** The outbound hop. Injected so no test reaches a tenant instance. */
  fetchImpl?: typeof fetch;
  /** Injected so a retry test does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

/**
 * Record one normalized SES event and hand it to its tenant's instance.
 *
 * Safe to call repeatedly with the same event: the second call short-circuits
 * on the unique index unless the first one left the row retryable — a `failed`
 * row under the ceiling, or a `pending` row a dead process abandoned, which a
 * redelivery may reclaim after {@link EMAIL_EVENT_PENDING_CLAIM_MS} (see
 * {@link claimSeenRow}).
 */
export async function ingestSesEvent(
  input: { region: SubstrateRegion; normalized: NormalizedSesEvent },
  deps: EmailEventDeps = {},
): Promise<EmailEventOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();
  const { event, tenantName, dedupeKey } = input.normalized;

  const target = tenantName ? await resolveTenant(db, tenantName) : null;

  // INSERT FIRST. `onConflictDoNothing` returns no row when this event has
  // been seen, which is the whole dedupe: the database serialises the decision
  // rather than the application reading and then writing.
  const [inserted] = await db
    .insert(emailEvents)
    .values({
      environmentId: target?.environmentId ?? null,
      tenantName,
      region: input.region,
      dedupeKey,
      type: event.type,
      messageId: event.messageId,
      payload: event as unknown as Record<string, unknown>,
      status: "pending",
      // Stamped with OUR clock, not the column default, because the abandoned-
      // row claim window ({@link claimSeenRow}) is measured against this same
      // injected clock.
      updatedAt: now,
      occurredAt: new Date(event.occurredAt),
    })
    .onConflictDoNothing({ target: emailEvents.dedupeKey })
    .returning({ id: emailEvents.id });

  const existing = inserted ? null : await findByDedupeKey(db, dedupeKey);

  // Seen before AND certainly settled (`delivered` and `dropped` are terminal,
  // and a `failed` row at the ceiling stays failed). Nothing to do — and
  // deliberately no second delivery, because a duplicate bounce is a
  // suppression we cannot take back. Anything LESS certain — a retryable
  // failure, a `pending` row that may be abandoned — is decided atomically by
  // {@link claimSeenRow} below, never by this stale read.
  if (existing && !mayBeClaimable(existing)) {
    return { status: "duplicate", eventId: existing.id };
  }

  const eventId = inserted?.id ?? existing?.id;
  if (!eventId) {
    // A row that vanished between the conflict and the read. Temporary, not
    // final: the next redelivery re-inserts it — and the non-2xx the ingress
    // maps this to is what guarantees there IS a next redelivery.
    return { status: "in_flight", eventId: "unknown" };
  }

  let attemptsSoFar = 0;
  if (existing) {
    const claim = await claimSeenRow(db, existing, now);
    if (claim.outcome === "settled") {
      // The abandoned-at-ceiling tidy-up just made the row terminal. Nothing
      // will ever deliver it, so this is a FINAL answer.
      return { status: "duplicate", eventId: existing.id };
    }
    if (claim.outcome === "in_flight") {
      // The database said "not yours, not now": a concurrent request may hold
      // the row. TEMPORARY — the ingress invites SNS back rather than 200ing
      // away the only retry that could ever recover an abandoned row.
      return { status: "in_flight", eventId: existing.id };
    }
    // The claim ticked `attempts` as its crash marker (see claimSeenRow); the
    // real accounting below re-derives from the pre-claim value so a settled
    // outcome counts only true delivery attempts.
    attemptsSoFar = claim.attempts - 1;
  }

  // ---- resolve --------------------------------------------------------------
  if (!target) {
    // RECORD AND DROP (PRD 05 EARS 6). Terminal on purpose: an unknown tenant
    // does not become known by waiting, and broadcasting is never the answer.
    await settle(db, eventId, {
      status: "dropped",
      attempts: attemptsSoFar,
      lastError: tenantName
        ? `SES tenant ${JSON.stringify(tenantName)} resolves to no environment`
        : "the notification named no SES tenant",
      now,
    });
    return {
      status: "dropped",
      eventId,
      reason: tenantName ? "unresolved_tenant" : "no_tenant_tag",
    };
  }

  // A stack mid-provision has no public URL yet. That is TRANSIENT, and a
  // dropped bounce is permanent, so it is a retryable failure rather than a
  // drop. The attempt counter still ticks even though no request was made —
  // otherwise a stack that never finishes provisioning would re-drive against
  // the ceiling forever, which is the one thing this must never do.
  if (!target.apiPublicUrl) {
    return failed(db, eventId, {
      attempts: attemptsSoFar + 1,
      error: "the environment's instance has no public URL yet",
      now,
    });
  }

  // ---- deliver --------------------------------------------------------------
  const budget = Math.max(
    0,
    Math.min(
      EMAIL_EVENT_ATTEMPTS_PER_REQUEST,
      EMAIL_EVENT_MAX_ATTEMPTS - attemptsSoFar,
    ),
  );

  const result = await postToInstance({
    url: instanceWebhookUrl(target.apiPublicUrl),
    // The bytes we sign are the bytes we send. The engine verifies over
    // `await c.req.text()` — the EXACT received body — so re-serializing
    // anywhere between here and the wire would break every signature.
    payload: JSON.stringify(event),
    secret: target.webhookSecret,
    attempts: budget,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });

  const attempts = attemptsSoFar + result.attempts;

  if (result.ok) {
    await settle(db, eventId, { status: "delivered", attempts, now });
    return { status: "delivered", eventId, attempts };
  }

  return failed(db, eventId, { attempts, error: result.error, now });
}

async function failed(
  db: CloudDb,
  eventId: string,
  input: { attempts: number; error: string; now: Date },
): Promise<EmailEventOutcome> {
  const exhausted = input.attempts >= EMAIL_EVENT_MAX_ATTEMPTS;
  await settle(db, eventId, {
    status: "failed",
    attempts: input.attempts,
    lastError: input.error,
    now: input.now,
  });
  return {
    status: "failed",
    eventId,
    attempts: input.attempts,
    exhausted,
    error: input.error,
  };
}

// ---------------------------------------------------------------------------
// The outbound hop
// ---------------------------------------------------------------------------

export interface InstanceDeliveryResult {
  ok: boolean;
  attempts: number;
  error: string;
}

/**
 * POST one signed relay event to a tenant instance, with bounded backoff.
 *
 * The signature is produced by `signHogsendRelayWebhook`, IMPORTED from
 * `@hogsend/plugin-hogsend` — the exact function the instance verifies with.
 * A wire whose two ends implement the same scheme twice is a wire with two
 * chances to get it wrong, and getting it wrong here means every event is
 * silently rejected and bounce handling quietly does nothing.
 */
export async function postToInstance(input: {
  url: string;
  payload: string;
  secret: string;
  attempts: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<InstanceDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const signature = signHogsendRelayWebhook({
    payload: input.payload,
    secret: input.secret,
  });

  let attempts = 0;
  let error = "no delivery attempt was made";

  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(
        RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1) ?? 0,
      );
    }
    attempts += 1;

    let response: Response;
    try {
      response = await fetchImpl(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HOGSEND_RELAY_SIGNATURE_HEADER]: signature,
        },
        body: input.payload,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch (cause) {
      error = `the instance webhook could not be reached: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      continue;
    }

    if (response.ok) return { ok: true, attempts, error: "" };

    error = `the instance webhook answered ${response.status}`;
    // NEVER retry a 4xx (429 excepted). A 401 means the instance rejected our
    // signature and a 400 means it rejected our shape; both will refuse
    // identically next time, so retrying only hammers a tenant.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      return { ok: false, attempts, error };
    }
  }

  return { ok: false, attempts, error };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EmailEventRow = typeof emailEvents.$inferSelect;

interface TenantTarget {
  environmentId: string;
  webhookSecret: string;
  apiPublicUrl: string | null;
}

/**
 * The SES tenant name → the environment that owns it, its instance URL and the
 * secret its webhooks are signed with. One LEFT JOIN: a `ses_tenants` row can
 * legitimately exist before its stack has a public URL.
 */
async function resolveTenant(
  db: CloudDb,
  tenantName: string,
): Promise<TenantTarget | null> {
  const [row] = await db
    .select({
      environmentId: sesTenants.environmentId,
      webhookSecretEncrypted: sesTenants.webhookSecretEncrypted,
      substrateRefs: stacks.substrateRefs,
    })
    .from(sesTenants)
    .leftJoin(stacks, eq(stacks.environmentId, sesTenants.environmentId))
    .where(eq(sesTenants.tenantName, tenantName))
    .limit(1);
  if (!row) return null;

  return {
    environmentId: row.environmentId,
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
): Promise<EmailEventRow | undefined> {
  const [row] = await db
    .select()
    .from(emailEvents)
    .where(eq(emailEvents.dedupeKey, dedupeKey))
    .limit(1);
  return row;
}

/**
 * Whether a previously-seen row MIGHT still need a delivery — the cheap read
 * gate in front of {@link claimSeenRow}, so the common duplicate (a settled
 * row) costs one SELECT and no UPDATE.
 *
 * `delivered` and `dropped` are terminal, and a `failed` row at the ceiling
 * stays failed. A `failed` row under it is a real retry. `pending` is the one
 * this cannot decide: it is EITHER a request at the wire right now OR a
 * process that died before `settle` — so this only ever rules rows OUT; ruling
 * one in is the claim's conditional UPDATE, where the database serialises the
 * answer.
 */
function mayBeClaimable(row: EmailEventRow): boolean {
  if (row.status === "failed") return row.attempts < EMAIL_EVENT_MAX_ATTEMPTS;
  return row.status === "pending";
}

/**
 * Atomically claim a previously-seen row for THIS request — or for nobody.
 *
 * The tension this resolves: a `pending` row is EITHER in flight in a
 * concurrent request (SNS can hand one notification to two of our instances
 * at once, and recovering it would turn one bounce into two deliveries) OR
 * abandoned by a process that died between the insert and `settle` (and never
 * recovering it loses the bounce forever — a suppression that never happens).
 * The row alone cannot say which, so the DATABASE decides, the same way the
 * insert-is-the-dedupe does: one conditional UPDATE whose WHERE matches only
 *
 *  - a `failed` row under the attempt ceiling (the ordinary bounded retry), or
 *  - a `pending` row untouched for {@link EMAIL_EVENT_PENDING_CLAIM_MS} —
 *    longer than any LIVE request can possibly hold it.
 *
 * Two concurrent claimants serialise on the row lock; the loser re-evaluates
 * the predicate against the winner's write (`pending`, fresh `updatedAt`) and
 * matches nothing. Exactly one proceeds to the wire.
 *
 * The claim ticks `attempts` — that tick is the CRASH MARKER. A claimant that
 * dies before settling leaves it behind, so a crash-looping row burns one
 * attempt per claim and the ceiling still binds; a claimant that settles
 * normally overwrites it with the true count (the caller re-derives
 * `attemptsSoFar` from the pre-claim value). A row abandoned AT the ceiling
 * can never be claimed again, so it is settled `failed` here — terminal, and
 * visible on the status index an operator reads — rather than parked
 * `pending` forever.
 *
 * A refused claim is one of two very different answers, and the caller MUST
 * treat them differently at the HTTP layer: `settled` is final (the tidy-up
 * just made the row terminal — 200, stop SNS), while `in_flight` is temporary
 * (somebody may hold the row — non-2xx, so SNS retries and the LATER attempt
 * finds it settled or claimable). Collapsing both to "duplicate" is exactly
 * the bug this function exists to fix: the 200 would cancel the only retry
 * that could ever recover an abandoned row.
 */
async function claimSeenRow(
  db: CloudDb,
  row: EmailEventRow,
  now: Date,
): Promise<
  | { outcome: "claimed"; attempts: number }
  | { outcome: "settled" }
  | { outcome: "in_flight" }
> {
  const abandonedBefore = new Date(
    now.getTime() - EMAIL_EVENT_PENDING_CLAIM_MS,
  );
  const [claimed] = await db
    .update(emailEvents)
    .set({
      status: "pending",
      attempts: sql`${emailEvents.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(emailEvents.id, row.id),
        lt(emailEvents.attempts, EMAIL_EVENT_MAX_ATTEMPTS),
        or(
          eq(emailEvents.status, "failed"),
          and(
            eq(emailEvents.status, "pending"),
            lte(emailEvents.updatedAt, abandonedBefore),
          ),
        ),
      ),
    )
    .returning({ attempts: emailEvents.attempts });
  if (claimed) return { outcome: "claimed", attempts: claimed.attempts };

  if (row.status === "pending" && row.attempts >= EMAIL_EVENT_MAX_ATTEMPTS) {
    // Abandoned AND out of attempts: unclaimable forever, so make it terminal.
    // Conditional like the claim itself — a row that is merely young, or that
    // somebody settled meanwhile, is left alone.
    const [settled] = await db
      .update(emailEvents)
      .set({
        status: "failed",
        lastError:
          "abandoned mid-delivery with the attempt ceiling already reached",
        updatedAt: now,
      })
      .where(
        and(
          eq(emailEvents.id, row.id),
          eq(emailEvents.status, "pending"),
          lte(emailEvents.updatedAt, abandonedBefore),
          gte(emailEvents.attempts, EMAIL_EVENT_MAX_ATTEMPTS),
        ),
      )
      .returning({ id: emailEvents.id });
    if (settled) return { outcome: "settled" };
  }
  return { outcome: "in_flight" };
}

async function settle(
  db: CloudDb,
  eventId: string,
  input: {
    status: EmailEventRow["status"];
    attempts: number;
    lastError?: string;
    now: Date;
  },
): Promise<void> {
  await db
    .update(emailEvents)
    .set({
      status: input.status,
      attempts: input.attempts,
      lastError: input.lastError ?? null,
      deliveredAt: input.status === "delivered" ? input.now : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(emailEvents.id, eventId),
        // Never walk a terminal row backwards: a slow request finishing after
        // a redelivery already settled the row must not un-deliver it.
        sql`${emailEvents.status} <> 'delivered'`,
      ),
    );
}
