import type {
  EnrichmentProvider,
  EnrichmentQuery,
  EnrichmentResult,
} from "@hogsend/core";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import type {
  EnrichmentLookupKind,
  EnrichmentLookupStatus,
} from "./enrichment-ledger.js";
import { flattenTraits } from "./refine-traits.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RefineContactOptions {
  /** The contact's canonical key (`external_id ?? anonymous_id ?? id`). */
  userId?: string;
  email?: string;
  /** The contact row id — the unforgeable, engine-internal pin. */
  contactId?: string;
  /** Override the container's active enrichment provider by registry id. */
  provider?: string;
  /** Bypass the TTL + negative cache. Does NOT bypass the budget cap. */
  force?: boolean;
  /**
   * Disambiguates the replay key when two refine sites in one journey share a
   * nearest wait label. Mirrors `sendEmail`/`sendSms`/`sendConnectorAction`.
   */
  idempotencyLabel?: string;
}

export interface RefineContactResult {
  status: "refined" | "cached" | "not_found" | "skipped";
  /** Present on `skipped` — `no_lookup_key` | `no_provider` | `budget_exceeded` | `provider_error`. */
  reason?: string;
  /** The `refined_*` patch (on `refined`) or the stored traits (on `cached`). */
  properties?: Record<string, unknown>;
}

/** The refinement subject, resolved once BEFORE the durable memo is issued. */
export interface RefineTarget {
  /** `contacts.id`, when a row exists. */
  contactId?: string;
  /** Canonical contact key, used as the ingest `userId`. */
  userId?: string;
  email?: string;
  /** Company domain, when the contact carries one and has no email. */
  domain?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  /** The `refined_*` traits already on the contact — the `cached` payload. */
  refinedProperties?: Record<string, unknown>;
}

/** The event the refinement pipeline emits through `ingestEvent`. */
export const REFINE_EVENT = "contact.refined";

export interface RefineIngestInput {
  userId?: string;
  email?: string;
  contactId?: string;
  eventProperties: Record<string, unknown>;
  contactProperties: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Everything stateful the chain touches, injected. Two reasons this is a seam
 * rather than direct imports: `refineContact` must reach `ingestEvent` (which
 * needs the db/registry/hatchet/logger singletons) from a STANDALONE call site,
 * and the positional-journal law (AC 11) has to be provable by a pure test with
 * no database and no Hatchet client.
 */
export interface RefineChainDeps {
  /** The resolved ACTIVE provider, or undefined when none is configured. */
  provider?: EnrichmentProvider;
  /** The active provider's `meta.id` — what the ledger rows are keyed by. */
  providerId?: string;
  /** `ENRICHMENT_TTL_DAYS`. */
  ttlDays: number;
  /** `ENRICHMENT_MONTHLY_LOOKUPS`; 0 = uncapped. */
  monthlyCap: number;
  now: () => Date;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  resolveTarget(opts: RefineContactOptions): Promise<RefineTarget | null>;
  findLedgerRow(input: {
    provider: string;
    lookupKind: EnrichmentLookupKind;
    lookupKey: string;
  }): Promise<{ status: EnrichmentLookupStatus; expiresAt: Date } | null>;
  countLookupsSince(input: { since: Date }): Promise<number>;
  writeLedgerRow(input: {
    provider: string;
    lookupKind: EnrichmentLookupKind;
    lookupKey: string;
    status: EnrichmentLookupStatus;
    contactId?: string | null;
    refinedAt: Date;
    expiresAt: Date;
    raw?: unknown;
  }): Promise<void>;
  ingest(input: RefineIngestInput): Promise<void>;
  /** First instant of the budget window containing `at` (UTC calendar month). */
  budgetWindowStart(at: Date): Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The gate chain
// ---------------------------------------------------------------------------

/**
 * The refinement gate chain, in its fixed order.
 *
 * THE LAW (the single thing this file exists to get right): the Hatchet journal
 * is POSITIONAL, and `boundary.memoize` is a durable call, so its ISSUANCE must
 * never be conditional on a live DB read. The law is written out at
 * `lib/feed.ts:152-165`; the corrected shape is `lib/connector-actions.ts:320-381`
 * and this function mirrors it exactly.
 *
 * Refinement is the WORST case for the law, which is why the structure below is
 * not negotiable: the ledger gate reads the very row this function's own final
 * step writes. A naive "check the ledger, early-return `cached`, otherwise
 * memoize" would therefore issue the durable call on the first run and NOT issue
 * it on the replay — not racily, but on EVERY replay — shifting the journal and
 * getting the run killed with a non-determinism error.
 *
 * So:
 *
 *  - Steps 1 (resolve + derive `lookupKey`) and 2 (no active provider) run
 *    OUTSIDE the memo. Both are pure/config reads that cannot change between a
 *    run and its replay, so early-returning from them is safe.
 *  - Then, UNCONDITIONALLY, whenever a journey boundary exists: derive the key,
 *    `registerKey`, and issue `boundary.memoize`. No condition guards that call.
 *  - Steps 3-6 (ledger gate, budget cap, provider call, ledger write + ingest)
 *    all live INSIDE the memo closure, so EVERY verdict — `cached`,
 *    `not_found`, `budget_exceeded`, `provider_error`, `refined` — is recorded
 *    by the durable memo and replayed verbatim.
 *  - With NO boundary (a webhook, a cron, a test) the chain runs directly with
 *    no memo at all, exactly as `connector-actions.ts:342` does. Layer 2 — the
 *    `enrichment_lookups` unique index — carries exactly-once on its own there.
 */
export async function runRefineChain(
  deps: RefineChainDeps,
  opts: RefineContactOptions,
): Promise<RefineContactResult> {
  // ---- (1) Resolve the subject + the lookup key. OUTSIDE the memo. ----------
  const target = await deps.resolveTarget(opts);
  const email = target?.email?.trim() || undefined;
  const domain = target?.domain?.trim() || undefined;
  const lookupKey = email ?? domain;
  if (!target || !lookupKey) {
    return { status: "skipped", reason: "no_lookup_key" };
  }
  const lookupKind: EnrichmentLookupKind = email ? "email" : "domain";

  // ---- (2) No active provider. OUTSIDE the memo (a config read). -----------
  const provider = deps.provider;
  const providerId = deps.providerId ?? provider?.meta.id;
  if (!provider || !providerId) {
    return { status: "skipped", reason: "no_provider" };
  }

  const gate = (idempotencyKey?: string) =>
    runGates({
      deps,
      opts,
      provider,
      providerId,
      target,
      lookupKind,
      lookupKey,
      idempotencyKey,
    });

  const boundary = getJourneyBoundary();

  // Outside a journey run there is no replay to defend against and no boundary
  // to key from — run the gates directly (connector-actions.ts:342).
  if (!boundary) return gate();

  // UNCONDITIONAL from here: derive → register → memoize. Nothing between this
  // comment and the `memoize` call may read the database or branch on one.
  const site = opts.idempotencyLabel ?? boundary.currentLabel ?? lookupKey;
  const key = deriveJourneyKey({
    kind: "refine",
    anchor: boundary.runAnchor,
    site,
    discriminant: lookupKey,
  });
  registerKey(boundary, key);

  return boundary.memoize([key], () => gate(key));
}

/**
 * Steps 3-6 — everything stateful, and therefore everything that must be
 * RECORDED by the memo rather than re-derived on a replay. Cheap-before-spend
 * ordering still holds; it just holds inside the closure.
 */
async function runGates(args: {
  deps: RefineChainDeps;
  opts: RefineContactOptions;
  provider: EnrichmentProvider;
  providerId: string;
  target: RefineTarget;
  lookupKind: EnrichmentLookupKind;
  lookupKey: string;
  idempotencyKey?: string;
}): Promise<RefineContactResult> {
  const { deps, opts, provider, providerId, target, lookupKind, lookupKey } =
    args;

  // ---- (3) Ledger gate — TTL cache + negative cache. Zero spend. -----------
  if (!opts.force) {
    const row = await deps.findLedgerRow({
      provider: providerId,
      lookupKind,
      lookupKey,
    });
    if (row && row.expiresAt.getTime() > deps.now().getTime()) {
      // A `found` row is a PAID positive answer: hand back the traits the prior
      // lookup already landed on the contact (the ledger stores the vendor's
      // verbatim `raw`, so the contact row is the record of the normalized
      // patch).
      if (row.status === "found") {
        return { status: "cached", properties: target.refinedProperties ?? {} };
      }
      // A `not_found` row is a PAID negative answer — a miss costs money too.
      if (row.status === "not_found") return { status: "not_found" };
      // `error` deliberately falls through: it is not a paid result, so it must
      // never suppress a retry (AC 7).
    }
  }

  // ---- (4) Budget cap. Fails CLOSED; `force` does not bypass it. -----------
  if (deps.monthlyCap > 0) {
    const used = await deps.countLookupsSince({
      since: deps.budgetWindowStart(deps.now()),
    });
    if (used >= deps.monthlyCap) {
      deps.logger.warn("refineContact: monthly enrichment budget exhausted", {
        provider: providerId,
        used,
        cap: deps.monthlyCap,
      });
      return { status: "skipped", reason: "budget_exceeded" };
    }
  }

  // ---- (5) The one call that costs money. ----------------------------------
  const query: EnrichmentQuery = {
    ...(target.email ? { email: target.email } : {}),
    ...(target.domain ? { domain: target.domain } : {}),
    ...(target.firstName ? { firstName: target.firstName } : {}),
    ...(target.lastName ? { lastName: target.lastName } : {}),
    ...(target.company ? { company: target.company } : {}),
  };

  let result: EnrichmentResult;
  try {
    result = await provider.enrichPerson(query);
  } catch (error) {
    // A vendor failure must never fail the journey run or the ingest that
    // triggered it. Record it, and return a skip.
    deps.logger.error("refineContact: enrichment provider failed", {
      provider: providerId,
      lookupKind,
      error: error instanceof Error ? error.message : String(error),
    });
    const failedAt = deps.now();
    try {
      await deps.writeLedgerRow({
        provider: providerId,
        lookupKind,
        lookupKey,
        status: "error",
        contactId: target.contactId ?? null,
        refinedAt: failedAt,
        // Already expired on arrival — belt-and-braces behind the status check
        // in step 3, so an `error` row can never suppress a later retry.
        expiresAt: failedAt,
        raw: null,
      });
    } catch (writeError) {
      deps.logger.error("refineContact: could not record the error lookup", {
        provider: providerId,
        error:
          writeError instanceof Error ? writeError.message : String(writeError),
      });
    }
    return { status: "skipped", reason: "provider_error" };
  }

  // ---- (6) Ledger row FIRST, then the ingest that closes the loop. ---------
  const refinedAt = deps.now();
  await deps.writeLedgerRow({
    provider: providerId,
    lookupKind,
    lookupKey,
    status: result.found ? "found" : "not_found",
    contactId: target.contactId ?? null,
    refinedAt,
    expiresAt: new Date(refinedAt.getTime() + deps.ttlDays * MS_PER_DAY),
    raw: result.raw,
  });

  const properties = flattenTraits(result, {
    provider: providerId,
    refinedAt,
  });

  // THROUGH `ingestEvent`, never `resolveOrCreateContact`: only the ingest path
  // re-runs `checkBucketMembership`, and that synchronous re-evaluation is the
  // entire point — it is what turns a fit trait into a bucket transition.
  await deps.ingest({
    ...(target.userId ? { userId: target.userId } : {}),
    ...(target.email ? { email: target.email } : {}),
    ...(target.contactId ? { contactId: target.contactId } : {}),
    eventProperties: { provider: providerId, found: result.found },
    contactProperties: properties,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  });

  return result.found
    ? { status: "refined", properties }
    : { status: "not_found" };
}
