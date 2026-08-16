import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations } from "../db/schema";
import {
  getRelay,
  type RelayProvider,
  type RelaySendBatchResult,
  SesRelayProvider,
} from "../relay";
import {
  claimIdempotencyKey,
  commitIdempotencyClaim,
  releaseIdempotencyClaim,
  releaseIdempotencyClaims,
  sweepEmailIdempotency,
} from "../services/email-idempotency";
import {
  blocksSending,
  type EmailSendingStatusRecord,
  readEmailSendingStatus,
  recordEmailSendingStatus,
} from "../services/email-sending-status";
import { createEmailAllowanceGate } from "../services/email-usage";
import { RelayTokenService } from "../services/relay-tokens";
import type { SesClient } from "../ses/contract";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { SesError, type SesErrorKind, type SesMessage } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import type { AllowanceGate } from "./email-allowance";
import {
  assertValidAttachments,
  InvalidAttachmentError,
  toSesAttachment,
  type WireEmailAttachment,
} from "./email-attachments";
import {
  checkTierSendCap,
  type TierCapRefusal,
  tierCapMessage,
} from "./email-tier-cap";
import { bearerToken } from "./publish-guards";
import { consumeRateLimit } from "./rate-limit";
import { fail } from "./route-response";

/**
 * THE SEND RELAY (PRD 03).
 *
 * A tenant instance holds a relay token and nothing else; the AWS credential
 * lives here and never leaves. That is the entire reason this endpoint exists
 * rather than each instance holding scoped IAM keys.
 *
 * The order of operations is load-bearing, and each step is here because the
 * step after it is expensive or irreversible:
 *
 *   auth → paused → rate limit → validate → tier cap → allowance → idempotency
 *     → send
 *
 *  - **auth** first, so nothing below is reachable anonymously. The token
 *    resolves an ENVIRONMENT, and the environment determines the SES tenant. A
 *    request body may not name its own tenant — if it could, tenant isolation
 *    would be advisory, so the request schemas are STRICT and any attempt to
 *    supply one is a 400 rather than a silently ignored field;
 *  - **paused** before anything else that costs something, so a stopped tenant
 *    costs no round trip and gets no escape hatch (DECISIONS §6: fail closed,
 *    loudly, no fallback);
 *  - **rate limit** before ANY caller-controlled input is inspected, so a flood
 *    of malformed or key-less requests is bounded too, and before the allowance
 *    seam, so a throttled request consumes no allowance. The monthly allowance
 *    is a ceiling and does nothing to stop a leaked token emptying it in ninety
 *    seconds; the burst limit is the only control that operates on the timescale
 *    an incident does. A batch charges ONE unit here and the remaining
 *    `items.length - 1` immediately after validation, because its true cost is
 *    the item count and that cannot be known before the body is parsed —
 *    charging one per request would make batching a way to buy fifty times the
 *    budget;
 *  - **validate** before the allowance seam, so a malformed body never spends
 *    a tenant's allowance;
 *  - **tier cap** before the allowance, and SEPARATE from it (PRD 08). The
 *    allowance is a plan/billing ceiling a customer can raise by paying; the
 *    tier cap is an abuse control that no amount of money lifts. Merging them
 *    would mean one number doing two jobs, and the first time a `watched`
 *    tenant upgraded their plan the abuse control would quietly widen;
 *  - **idempotency** last before the wire, and by INSERT-then-conflict rather
 *    than check-then-insert — see `services/email-idempotency.ts`;
 *  - **send** with the tenant name and configuration set the ENVIRONMENT owns.
 */

/**
 * Messages per environment per minute.
 *
 * Ten a second, per environment. It is deliberately below SES's own typical
 * per-account send rate, because that quota is shared by every tenant on the
 * account: one environment consuming all of it is exactly the incident this
 * bounds. It is far above what a journey fan-out or a paced broadcast asks for
 * from one instance, so it never binds on legitimate traffic — and a leaked
 * token is capped at a known, survivable number rather than at the month's
 * whole allowance.
 */
export const EMAIL_RELAY_BURST_LIMIT = 600;
export const EMAIL_RELAY_WINDOW_MS = 60_000;

/** Keyed on the ENVIRONMENT, never the client IP: the caller is a tenant
 * instance, so its address is neither stable nor the thing being limited. */
export function emailRelayBucket(environmentId: string): string {
  return `email_relay:${environmentId}`;
}

/** SES accepts at most 50 destinations on one message. */
const MAX_RECIPIENTS = 50;
/** One request, one batch. Bounded so a single call cannot become a campaign. */
export const MAX_BATCH_ITEMS = 50;
/** An idempotency key is an identifier, not a payload. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** Rendered HTML for one message. Generous; SES's own ceiling is the real one. */
const MAX_BODY_CHARS = 1_000_000;
/**
 * The whole JSON request for ONE message (PRD 17). Sized from the attachment
 * cap, not guessed: `MAX_ATTACHMENT_BYTES` (25 MiB raw) inflates to ~33.4 MiB
 * as base64 on the wire, plus up to two `MAX_BODY_CHARS` bodies and JSON
 * structure — ~36 MiB for the heaviest legitimate send. 40 MiB covers that
 * with headroom, and is also SES's own per-message ceiling (40 MB after
 * encoding), so nothing this cap admits is doomed at the wire. Checked BEFORE
 * parsing (see `readJson`), because refusing a 200 MB request after decoding
 * it would be a memory bill, not a cap.
 */
export const MAX_SEND_REQUEST_BYTES = 40 * 1024 * 1024;
/**
 * The whole JSON request for a BATCH. The attachment size cap is PER MESSAGE
 * (matching SES's per-message limit), so without its own body cap a batch of
 * fifty maximal messages would be a ~1.7 GB allocation on one request. This
 * admits one maximal-attachment message (~33.4 MiB encoded) alongside a full
 * complement of ordinary items — a batch of several attachment-heavy messages
 * must split across requests, which bounds what a single request can make this
 * process buffer. Deliberately BELOW the schema's theoretical maximum, the
 * same posture the old 16 MiB cap held.
 */
export const MAX_BATCH_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * An address as this relay checks it: bounded, and containing an `@`.
 *
 * Deliberately NOT a full RFC 5322 validation. `from` legitimately carries a
 * display name, internationalised domains are real, and a relay that were
 * stricter than SES would refuse mail SES would have delivered. The `@` is
 * enough to catch a wiring bug; SES is the authority on the rest, and its
 * refusal comes back as a per-message `invalid`.
 */
const address = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => value.includes("@"), "must be an email address");

/**
 * One attachment on the wire (PRD 17): `content` is the file's bytes as
 * base64, ALWAYS — JSON cannot carry raw bytes, so there is no discriminant to
 * get wrong. Only the STRUCTURE lives here; the semantic rules (filename
 * shape, length caps, count, base64 validity, the raw-byte total) live in
 * `assertValidAttachments` (`lib/email-attachments.ts`, the hand-synced mirror
 * of `@hogsend/core`'s validator), so the relay and the engine mailer spell
 * every refusal identically.
 */
const attachmentSchema = z.strictObject({
  filename: z.string(),
  content: z.string().min(1),
  contentType: z.string().optional(),
  disposition: z.enum(["attachment", "inline"]).optional(),
  contentId: z.string().optional(),
});

/**
 * STRICT, and that is the enforcement of two locked decisions at once:
 *  - **HTML only.** A payload carrying `react` or a `template` reference is
 *    refused. The engine renders before the wire, always;
 *  - **no self-named tenant.** `tenantName` / `configurationSetName` are not
 *    fields a caller may supply, so an attempt to send as another tenant is a
 *    400 rather than an ignored key somebody later "helpfully" reads.
 */
const messageSchema = z
  .strictObject({
    from: address,
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(address).max(MAX_RECIPIENTS).optional(),
    replyTo: z.array(address).max(MAX_RECIPIENTS).optional(),
    subject: z.string().max(998),
    html: z.string().max(MAX_BODY_CHARS).optional(),
    text: z.string().max(MAX_BODY_CHARS).optional(),
    headers: z.record(z.string().max(128), z.string().max(8192)).optional(),
    tags: z
      .array(
        z.strictObject({
          name: z.string().max(256),
          value: z.string().max(256),
        }),
      )
      .max(32)
      .optional(),
    // No `.max()` here on purpose: the count cap is `MAX_ATTACHMENT_COUNT` in
    // the shared validator, where its refusal names the count and the limit
    // rather than surfacing as a generic schema issue.
    attachments: z.array(attachmentSchema).optional(),
  })
  .refine(
    (message) => Boolean(message.html) || Boolean(message.text),
    "a message needs an html or a text body",
  );

const sendBodySchema = z.strictObject({ message: messageSchema });

const batchBodySchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .max(MAX_IDEMPOTENCY_KEY_LENGTH),
        message: messageSchema,
      }),
    )
    .min(1)
    .max(MAX_BATCH_ITEMS),
});

/** Everything the relay knows about the caller, all of it derived from the
 * token. Nothing here can be influenced by the request body. */
export interface RelayCaller {
  environmentId: string;
  organizationId: string;
  region: SubstrateRegion;
  tokenId: string;
  tenantName: string;
  configurationSetName: string;
}

export interface RelayDeps {
  db?: CloudDb;
  /** The provider-neutral wire. Defaults to `getRelay(region)`. */
  relay?: RelayProvider;
  /**
   * A test-injection convenience: a raw `SesClient` the resolver wraps in a
   * `SesRelayProvider`. Superseded by `relay` when both are supplied.
   */
  ses?: SesClient;
  /** Defaults to the real `usage_counters`-backed gate (PRD 09). */
  allowance?: AllowanceGate;
  now?: Date;
}

/**
 * The relay this request sends through. Precedence: an explicit `relay`, then a
 * `SesClient` wrapped in the adapter (so a test injecting `{ ses }` drives the
 * SAME fake through the neutral seam), then the process-wide `getRelay(region)`.
 */
function resolveRelay(deps: RelayDeps, region: SubstrateRegion): RelayProvider {
  return (
    deps.relay ?? (deps.ses ? new SesRelayProvider(deps.ses) : getRelay(region))
  );
}

/**
 * The gate this request is judged by — and metered into.
 *
 * The default is the REAL one, so a route with nothing injected both enforces
 * the plan allowance and counts what it sends. A test that wants a relay with
 * no meter behind it passes `unlimitedAllowance`.
 */
function allowanceGate(deps: RelayDeps, db: CloudDb): AllowanceGate {
  return deps.allowance ?? createEmailAllowanceGate({ db });
}

export type RelayAuth =
  | { ok: true; caller: RelayCaller }
  | { ok: false; response: Response };

/**
 * Who is calling, and which SES tenant they may send as.
 *
 * The region comes from the ORGANIZATION rather than the stack: a stack row may
 * not exist yet (`CLOUD_PROVISION_ON=first-publish` births one `deferred`), and
 * the stack's own region is copied from the organization at creation, so the
 * organization is both the always-present and the authoritative source.
 */
export async function resolveRelayCaller(
  request: Request,
  deps: RelayDeps = {},
): Promise<RelayAuth> {
  const db = deps.db ?? defaultDb;

  const token = bearerToken(request.headers);
  if (!token) {
    return {
      ok: false,
      response: fail(
        401,
        "missing_token",
        "Send the environment's relay token as `Authorization: Bearer hsrel_…`.",
      ),
    };
  }

  const verified = await new RelayTokenService(db).verify({ token });
  if (!verified.found) {
    return {
      ok: false,
      response: fail(
        401,
        "invalid_token",
        "That relay token is not valid. Rotate it from the environment's settings.",
      ),
    };
  }

  const [row] = await db
    .select({
      organizationId: environments.organizationId,
      region: organizations.region,
    })
    .from(environments)
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .where(eq(environments.id, verified.environmentId))
    .limit(1);

  // A live token whose environment is gone. The cascade should have taken the
  // token with it, so this is a torn state — fail closed, and say no more than
  // "not valid".
  if (!row) {
    return {
      ok: false,
      response: fail(
        401,
        "invalid_token",
        "That relay token is not valid. Rotate it from the environment's settings.",
      ),
    };
  }

  return {
    ok: true,
    caller: {
      environmentId: verified.environmentId,
      organizationId: row.organizationId,
      region: row.region,
      tokenId: verified.tokenId,
      // THE tenant. Derived from the token's environment, never from the body.
      tenantName: sesTenantName(verified.environmentId),
      configurationSetName: sesConfigurationSetName(verified.environmentId),
    },
  };
}

/** `POST /api/email/send` — one message. */
export async function handleRelaySend(
  request: Request,
  deps: RelayDeps = {},
): Promise<Response> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();

  const auth = await resolveRelayCaller(request, deps);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  const paused = await pausedResponse(caller, db);
  if (paused) return paused;

  // Charged BEFORE anything a caller controls is inspected, so a flood of
  // malformed or key-less requests is bounded too. Costing exactly one is why
  // the batch charges one here and the rest once it knows its item count.
  const limit = await charge(caller, 1, deps, now);
  if (!limit.allowed) return limit.response;

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return fail(
      400,
      "missing_idempotency_key",
      "Send the message's replay-stable key as an `Idempotency-Key` header.",
    );
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return fail(
      400,
      "missing_idempotency_key",
      `An \`Idempotency-Key\` may be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }

  const body = await readJson(request, MAX_SEND_REQUEST_BYTES);
  if (!body.ok) return body.response;
  const parsed = sendBodySchema.safeParse(body.value);
  if (!parsed.success) return invalidRequest(parsed.error);

  // Part of VALIDATE, so it sits where validate sits: after the schema, before
  // the tier cap and the allowance. A refused attachment spends no allowance,
  // reaches no tier cap, claims no idempotency key and never touches SES. The
  // ONE burst unit is already gone — charged above, before any caller-
  // controlled input was inspected, exactly as the comment on `charge` says.
  const attachmentRefusal = refuseInvalidAttachments(parsed.data.message);
  if (attachmentRefusal) return attachmentRefusal;

  const tierCap = await checkTierSendCap({
    environmentId: caller.environmentId,
    organizationId: caller.organizationId,
    count: 1,
    now,
    db,
  });
  if (!tierCap.allowed) return tierCapRefused(tierCap);

  const gate = allowanceGate(deps, db);
  const allowance = await gate.canSend({
    environmentId: caller.environmentId,
    organizationId: caller.organizationId,
    count: 1,
  });
  if (!allowance.allowed) return allowanceRefused(allowance);

  const claim = await claimIdempotencyKey({
    environmentId: caller.environmentId,
    idempotencyKey,
    now,
    db,
  });
  if (claim.outcome === "replay") {
    return json(200, { id: claim.messageId });
  }
  if (claim.outcome === "in_flight") {
    return fail(
      409,
      "send_in_progress",
      "An identical send is at the wire right now. Retry in a moment to get its id.",
      { "retry-after": "1" },
    );
  }

  const relay = resolveRelay(deps, caller.region);
  try {
    const { id } = await relay.send({
      tenantName: caller.tenantName,
      configurationSetName: caller.configurationSetName,
      message: toSesMessage(parsed.data.message),
    });
    await commitIdempotencyClaim({ rowId: claim.rowId, messageId: id, db });
    // AFTER the wire, and only on the path that reached it: the replay branch
    // above returned without counting, which is what stops a journey replay
    // billing twice.
    await meter(gate, caller, 1, now);
    return json(200, { id });
  } catch (error) {
    // NOTHING is left behind by a send that did not happen: a recorded key for
    // an undelivered message turns a blip into permanent silent loss. The
    // `claimedAt` scopes the delete to OUR claim — if this send outlived the
    // takeover window and somebody re-claimed the key, their claim survives.
    await releaseIdempotencyClaim({
      rowId: claim.rowId,
      claimedAt: claim.claimedAt,
      db,
    });
    return sendFailureResponse(error, caller, db, now);
  }
}

/** One entry of a batch response, positional with the request's `items`. */
export type RelayBatchResult =
  | { status: "sent"; id: string; idempotent?: true }
  | { status: "failed"; error: string; message: string };

/** `POST /api/email/send-batch` — many messages, per-item outcomes. */
export async function handleRelaySendBatch(
  request: Request,
  deps: RelayDeps = {},
): Promise<Response> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();

  const auth = await resolveRelayCaller(request, deps);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  const paused = await pausedResponse(caller, db);
  if (paused) return paused;

  // One unit before the body is read, so a flood of malformed batches is
  // bounded too; the rest of the cost is charged once the item count is known.
  const entry = await charge(caller, 1, deps, now);
  if (!entry.allowed) return entry.response;

  const body = await readJson(request, MAX_BATCH_REQUEST_BYTES);
  if (!body.ok) return body.response;
  const parsed = batchBodySchema.safeParse(body.value);
  if (!parsed.success) return invalidRequest(parsed.error);
  const { items } = parsed.data;

  // PER MESSAGE, like the schema failure above: one invalid item refuses the
  // whole request, named. A refused batch spends no allowance, reaches no
  // tier cap and claims no idempotency key; the single entry burst unit is
  // already spent — deliberately, per the comment above — and the remaining
  // `items.length - 1` units are never charged. The size cap is per message
  // too: SES's 40 MB is per message, so a batch summing over the cap while
  // each item is under it is legitimate; what bounds the batch as a whole is
  // `MAX_BATCH_REQUEST_BYTES`.
  for (const [index, item] of items.entries()) {
    const refusal = refuseInvalidAttachments(item.message, `items[${index}]`);
    if (refusal) return refusal;
  }

  // Two items in ONE request sharing a key would race each other through the
  // guard, and one of them would come back `send_in_progress` for no reason a
  // caller could act on. It is a caller bug, so say so.
  const keys = new Set(items.map((item) => item.idempotencyKey));
  if (keys.size !== items.length) {
    return fail(
      400,
      "duplicate_idempotency_key",
      "Every item in a batch needs its own `idempotencyKey`.",
    );
  }

  if (items.length > 1) {
    const rest = await charge(caller, items.length - 1, deps, now);
    if (!rest.allowed) return rest.response;
  }

  const tierCap = await checkTierSendCap({
    environmentId: caller.environmentId,
    organizationId: caller.organizationId,
    count: items.length,
    now,
    db,
  });
  if (!tierCap.allowed) return tierCapRefused(tierCap);

  const gate = allowanceGate(deps, db);
  const allowance = await gate.canSend({
    environmentId: caller.environmentId,
    organizationId: caller.organizationId,
    count: items.length,
  });
  if (!allowance.allowed) return allowanceRefused(allowance);

  // PER ITEM, never per request. A batch key alone would make a partially
  // failed batch un-retryable: the retry would return the original response and
  // the failed items would never send.
  const results: (RelayBatchResult | undefined)[] = new Array(items.length);
  const pending: {
    index: number;
    rowId: string;
    claimedAt: Date;
    message: SesMessage;
  }[] = [];

  for (const [index, item] of items.entries()) {
    const claim = await claimIdempotencyKey({
      environmentId: caller.environmentId,
      idempotencyKey: item.idempotencyKey,
      now,
      db,
    });
    if (claim.outcome === "replay") {
      results[index] = {
        status: "sent",
        id: claim.messageId,
        idempotent: true,
      };
    } else if (claim.outcome === "in_flight") {
      results[index] = {
        status: "failed",
        error: "send_in_progress",
        message: "An identical send is at the wire right now.",
      };
    } else {
      pending.push({
        index,
        rowId: claim.rowId,
        claimedAt: claim.claimedAt,
        message: toSesMessage(item.message),
      });
    }
  }

  // Every item a replay means the wire is not touched AT ALL — which is what
  // makes a retried batch cost only its failures.
  if (pending.length > 0) {
    const relay = resolveRelay(deps, caller.region);
    let entries: RelaySendBatchResult["results"];
    try {
      ({ results: entries } = await relay.sendBatch({
        tenantName: caller.tenantName,
        configurationSetName: caller.configurationSetName,
        messages: pending.map((item) => item.message),
      }));
    } catch (error) {
      // Belt and braces. The AWS client fans out one `SendEmail` per message
      // and catches PER ENTRY, so it cannot throw wholesale — a real outage
      // arrives as every entry failing, handled below. This branch exists for a
      // future implementation that is less careful, and it does the only safe
      // thing: releases every claim, so the caller's retry can send.
      await releaseIdempotencyClaims({
        rowIds: pending.map((item) => item.rowId),
        // Every claim in this request was stamped with this one `now` —
        // fresh insert and takeover alike — so it proves ownership of all.
        claimedAt: now,
        db,
      });
      return sendFailureResponse(error, caller, db, now);
    }

    const failureKinds: SesErrorKind[] = [];
    let delivered = 0;
    for (const [position, item] of pending.entries()) {
      const outcome = entries[position];
      if (outcome?.status === "sent") {
        await commitIdempotencyClaim({
          rowId: item.rowId,
          messageId: outcome.messageId,
          db,
        });
        results[item.index] = { status: "sent", id: outcome.messageId };
        delivered += 1;
        continue;
      }
      await releaseIdempotencyClaim({
        rowId: item.rowId,
        claimedAt: item.claimedAt,
        db,
      });
      const kind = outcome?.kind ?? "unknown";
      failureKinds.push(kind);
      results[item.index] = {
        status: "failed",
        error: batchErrorSlug(kind),
        // A missing positional entry is a seam bug rather than a delivery
        // outcome — name it rather than reporting a plausible-looking failure.
        message:
          outcome?.message ??
          "SES returned no result for this message; nothing was sent.",
      };
    }

    // What the wire ACCEPTED, which is what a batch is billed for: the items
    // that failed cost nothing, and the ones that replayed were counted the
    // first time round.
    await meter(gate, caller, delivered, now);

    // A per-entry pause is still a pause: mirror it so the next request
    // short-circuits without dialling.
    if (failureKinds.some(isPausedKind)) {
      await recordEmailSendingStatus({
        environmentId: caller.environmentId,
        status: "paused",
        reason: pauseReason(
          failureKinds.find(isPausedKind) ?? "tenant_paused",
          undefined,
        ),
        at: now,
        source: "relay",
        db,
      });
    }

    // NOTHING got through. That is not the partial failure EARS 7 protects, it
    // is a whole-request outcome, and hiding it inside a 200 would make the
    // caller parse every item to discover the transport is down (or that they
    // are paused). So when every attempted message failed for ONE retryable or
    // fail-closed reason, the batch answers exactly as `send` would. Every
    // claim is already released either way, so a retry is safe.
    if (delivered === 0) {
      if (failureKinds.every(isPausedKind)) {
        return pausedJson(
          await readEmailSendingStatus({
            environmentId: caller.environmentId,
            db,
          }),
        );
      }
      if (failureKinds.every(isRetryableKind)) return unavailable();
    }
  }

  return json(200, {
    results: results.map(
      (result) =>
        result ?? {
          status: "failed",
          error: "send_failed",
          message: "No result was produced for this message.",
        },
    ),
  });
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** The fail-closed gate. Read BEFORE anything else that costs something. */
async function pausedResponse(
  caller: RelayCaller,
  db: CloudDb,
): Promise<Response | null> {
  const status = await readEmailSendingStatus({
    environmentId: caller.environmentId,
    db,
  });
  return blocksSending(status.status) ? pausedJson(status) : null;
}

/**
 * The 403, in exactly one shape wherever it is decided — the pre-send gate, a
 * thrown `tenant_paused`, or a batch where every message came back paused.
 *
 * The reason travels VERBATIM, so the plugin can put a real sentence on the
 * journey's recorded failure rather than a generic one (DECISIONS §6).
 */
function pausedJson(status: EmailSendingStatusRecord): Response {
  return json(403, {
    error: "tenant_paused",
    message:
      "This environment's email sending is paused. Nothing was sent and nothing was queued.",
    reason: status.reason,
    pausedAt: status.pausedAt?.toISOString() ?? null,
  });
}

/** EARS 6. Every claim is released before this is returned, so the retry it
 * invites can genuinely succeed. */
function unavailable(): Response {
  return fail(
    503,
    "send_unavailable",
    "SES could not accept the message right now. Nothing was recorded, so a retry is safe.",
    { "retry-after": "5" },
  );
}

function isPausedKind(kind: SesErrorKind): boolean {
  return kind === "tenant_paused" || kind === "account_paused";
}

function isRetryableKind(kind: SesErrorKind): boolean {
  return kind === "throttled" || kind === "transient";
}

/**
 * Meter what went out.
 *
 * Best-effort, and deliberately so: the message has ALREADY left the building.
 * Failing the response now would tell the caller a delivered message was not
 * delivered, and its retry would replay the idempotency key and count nothing
 * anyway — so a metering failure is loud in the log and invisible on the wire.
 * A zero count writes nothing (see `recordRelayEmails`).
 */
async function meter(
  gate: AllowanceGate,
  caller: RelayCaller,
  count: number,
  now: Date,
): Promise<void> {
  if (count <= 0) return;
  await gate
    .recordSent({
      environmentId: caller.environmentId,
      organizationId: caller.organizationId,
      count,
      at: now,
    })
    .catch((error: unknown) => {
      console.error(
        `[cloud:email-relay] metering ${count} send(s) failed for environment ${caller.environmentId}:`,
        error,
      );
    });
}

type ChargeResult = { allowed: true } | { allowed: false; response: Response };

async function charge(
  caller: RelayCaller,
  cost: number,
  deps: RelayDeps,
  now: Date,
): Promise<ChargeResult> {
  const db = deps.db ?? defaultDb;
  const decision = await consumeRateLimit({
    bucket: emailRelayBucket(caller.environmentId),
    limit: EMAIL_RELAY_BURST_LIMIT,
    windowMs: EMAIL_RELAY_WINDOW_MS,
    cost,
    now,
    db,
  });

  // Once per environment per window, on the request that opened it: retire the
  // idempotency rows nobody will read again. Same idiom the limiter uses on its
  // own table — no cron, no sampling, no unbounded growth. A sweep failure must
  // never fail a send.
  if (decision.openedWindow) {
    await sweepEmailIdempotency({
      environmentId: caller.environmentId,
      now,
      db,
    }).catch((error: unknown) => {
      console.error(
        `[cloud:email-relay] idempotency sweep failed for environment ${caller.environmentId}:`,
        error,
      );
    });
  }

  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    response: fail(
      429,
      "rate_limited",
      `This environment may send ${decision.limit} messages per minute. Retry after the window rolls.`,
      { "retry-after": String(decision.retryAfterSeconds) },
    ),
  };
}

/**
 * How a thrown `SesError` becomes an HTTP answer.
 *
 * The claim has ALREADY been released by the caller before this runs, so every
 * branch here is safe to retry from the caller's point of view.
 */
async function sendFailureResponse(
  error: unknown,
  caller: RelayCaller,
  db: CloudDb,
  now: Date,
): Promise<Response> {
  if (!(error instanceof SesError)) {
    console.error(
      `[cloud:email-relay] unexpected send failure for environment ${caller.environmentId}:`,
      error,
    );
    return fail(
      502,
      "send_failed",
      "The send could not be completed. Nothing was recorded, so a retry is safe.",
    );
  }

  if (isPausedKind(error.kind)) {
    // EARS 5: persist BEFORE returning, so the next request short-circuits
    // without a network call.
    return pausedJson(
      await recordEmailSendingStatus({
        environmentId: caller.environmentId,
        status: "paused",
        reason: pauseReason(error.kind, error.detail ?? error.message),
        at: now,
        source: "relay",
        db,
      }),
    );
  }

  if (error.retryable) return unavailable();

  if (error.kind === "invalid") {
    return fail(400, "send_rejected", error.detail ?? error.message);
  }

  return fail(502, "send_failed", error.detail ?? error.message);
}

function pauseReason(kind: SesErrorKind, detail: string | undefined): string {
  const source =
    kind === "account_paused"
      ? "The sending account is suspended"
      : "SES paused this tenant";
  return detail ? `${source}: ${detail}` : source;
}

/** A per-item failure slug, mirroring the whole-request statuses above. */
function batchErrorSlug(kind: SesErrorKind): string {
  if (kind === "tenant_paused" || kind === "account_paused") {
    return "tenant_paused";
  }
  if (kind === "throttled" || kind === "transient") return "send_unavailable";
  if (kind === "invalid") return "send_rejected";
  return "send_failed";
}

/**
 * The attachment gate, one call site per endpoint. `null` means clean;
 * anything else is the 400, with the offending file (and for the size case
 * both the limit and the actual total) named by the shared validator. The
 * validator can only throw `InvalidAttachmentError` — anything else would be
 * OUR bug and is deliberately not swallowed into a customer-facing 400.
 */
function refuseInvalidAttachments(
  message: { attachments?: WireEmailAttachment[] },
  label?: string,
): Response | null {
  if (!message.attachments?.length) return null;
  try {
    assertValidAttachments(message.attachments);
  } catch (error) {
    if (error instanceof InvalidAttachmentError) {
      return fail(
        400,
        error.code,
        label ? `${label}: ${error.message}` : error.message,
      );
    }
    throw error;
  }
  return null;
}

/**
 * The parsed wire message onto the SES seam. A pass-through except for
 * attachments, which the seam wants in its `{ base64 }` wrapper — the wire is
 * always base64, so the wrapper is always the truthful declaration, and the
 * AWS layer knows not to encode the content a second time. `?.length`, not
 * bare truthiness: a message without attachments (or with `[]`) crosses the
 * seam with NO `attachments` key at all, byte-identical to today's sends.
 */
function toSesMessage(message: z.infer<typeof messageSchema>): SesMessage {
  const { attachments, ...rest } = message;
  return {
    ...rest,
    ...(attachments?.length
      ? { attachments: attachments.map(toSesAttachment) }
      : {}),
  };
}

type JsonRead =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

function tooLarge(maxBytes: number): JsonRead {
  return {
    ok: false,
    response: fail(
      413,
      "payload_too_large",
      `A relay request may be at most ${maxBytes} bytes.`,
    ),
  };
}

function unreadable(message: string): JsonRead {
  return { ok: false, response: fail(400, "invalid_request", message) };
}

/**
 * The body, capped TWICE — the same posture the publish intake holds, and for
 * the same reason.
 *
 * `Content-Length` is a HINT: it is checked first so an honest oversize request
 * is refused without reading a byte, and then the stream is METERED as it is
 * read, so a body that lied about (or omitted) its length cannot buy one byte
 * more than the cap. Without the second check, any tenant holding a valid token
 * could make this process buffer unbounded memory, and the burst limiter would
 * not stop it — a REFUSED request never reaches here, but six hundred allowed
 * ones a minute do.
 *
 * The cap is the CALLER's, because the two endpoints legitimately differ
 * (`MAX_SEND_REQUEST_BYTES` / `MAX_BATCH_REQUEST_BYTES`) — and it runs BEFORE
 * `JSON.parse` and the schema, so an oversize request is refused before
 * anything decodes it.
 */
async function readJson(request: Request, maxBytes: number): Promise<JsonRead> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return tooLarge(maxBytes);
  }
  if (!request.body) return unreadable("The request has no body.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch {
    return unreadable("The request body could not be read.");
  }

  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks, total).toString("utf-8")),
    };
  } catch {
    return unreadable("The request body is not JSON.");
  }
}

function invalidRequest(error: z.ZodError): Response {
  return json(
    400,
    {
      error: "invalid_request",
      message:
        "The request body is not a valid send. The relay takes rendered HTML only, and never a tenant name.",
      issues: error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    { "cache-control": "no-store" },
  );
}

/**
 * The tier cap's refusal (PRD 08 EARS 5).
 *
 * 403 rather than the allowance's 402 or the burst limiter's 429, and the
 * distinction is what a caller does next: 402 says pay, 429 says retry in a
 * moment, and this says neither is available — the cap lifts on a sending
 * record or on a human review, and nothing the caller does in the next minute
 * changes it. The message travels verbatim so a journey records a real
 * sentence.
 */
function tierCapRefused(refusal: TierCapRefusal): Response {
  return json(403, {
    error: refusal.reason,
    message: tierCapMessage(refusal),
    tier: refusal.tier,
    limit: refusal.limit,
    used: refusal.used,
    window: refusal.window,
  });
}

function allowanceRefused(
  refusal: Extract<
    Awaited<ReturnType<AllowanceGate["canSend"]>>,
    { allowed: false }
  >,
): Response {
  return json(
    402,
    {
      error: refusal.reason,
      message:
        "This environment has used its included email allowance for the period.",
      limit: refusal.limit,
      used: refusal.used,
      ...(refusal.resetsAt ? { resetsAt: refusal.resetsAt } : {}),
    },
    { "cache-control": "no-store" },
  );
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
