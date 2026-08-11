import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  signHogsendRelayWebhook,
} from "@hogsend/plugin-hogsend";
import { and, eq, sql } from "drizzle-orm";
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
  /** Already seen. The at-least-once collapse; nothing was delivered again. */
  | { status: "duplicate"; eventId: string }
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
 * on the unique index unless the first one left the row retryable.
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
      occurredAt: new Date(event.occurredAt),
    })
    .onConflictDoNothing({ target: emailEvents.dedupeKey })
    .returning({ id: emailEvents.id });

  const existing = inserted ? null : await findByDedupeKey(db, dedupeKey);

  // Seen before AND already settled. Nothing to do — and deliberately no second
  // delivery, because a duplicate bounce is a suppression we cannot take back.
  if (existing && !isRetryable(existing)) {
    return { status: "duplicate", eventId: existing.id };
  }

  const eventId = inserted?.id ?? existing?.id;
  if (!eventId) {
    // A row that vanished between the conflict and the read. Nothing sane to
    // do but treat it as handled; the next redelivery re-inserts it.
    return { status: "duplicate", eventId: "unknown" };
  }

  const attemptsSoFar = existing?.attempts ?? 0;

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
 * Whether a row we have seen before may be attempted again.
 *
 * Only a `failed` row under the ceiling. `delivered` and `dropped` are
 * terminal, and `pending` means another request is at the wire right now — a
 * second delivery would be exactly the duplicate the dedupe exists to prevent.
 */
function isRetryable(row: EmailEventRow): boolean {
  return row.status === "failed" && row.attempts < EMAIL_EVENT_MAX_ATTEMPTS;
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
