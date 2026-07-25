import type {
  EnrichmentProvider,
  EnrichmentQuery,
  EnrichmentResult,
} from "@hogsend/core";
import {
  type CallerRef,
  callerRefFromArgs,
  withDurableGate,
} from "../journeys/with-durable-gate.js";
import type {
  EnrichmentLookupKind,
  EnrichmentLookupStatus,
} from "./enrichment-ledger.js";
import { flattenTraits, REFINED_META_KEYS } from "./refine-traits.js";

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
  /**
   * Present on `skipped` — `no_lookup_key` | `no_provider` | `budget_exceeded`
   * | `provider_error` | `ingest_failed`.
   */
  reason?: string;
  /** The `refined_*` patch — on `refined` AND on `cached`. */
  properties?: Record<string, unknown>;
}

/** The refinement subject, resolved INSIDE the durable memo. */
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
  /** The `refined_*` traits already on THIS contact. */
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
 * What the outbound `contact.refined` emit needs. Handed to
 * {@link RefineChainDeps.emitRefined} on a GENUINE refinement and nothing else.
 *
 * `traitKeys` are the mapped trait NAMES, never their values — the payload says
 * what changed and a subscriber that wants the values reads the contact.
 */
export interface RefineEmitInput {
  /** The canonical contact key the traits landed under. */
  userId?: string;
  email?: string;
  contactId?: string;
  /** The enrichment provider id that answered. */
  provider: string;
  /** Sorted key NAMES of the `refined_*` patch. */
  traitKeys: string[];
  /** The lookup instant — the same value the patch's `refined_at` carries. */
  refinedAt: Date;
  /** Per-endpoint delivery dedupe — see {@link refineOutboundDedupeKey}. */
  dedupeKey: string;
}

/** What the ledger gate needs to know about a prior lookup. */
export interface RefineLedgerRow {
  status: EnrichmentLookupStatus;
  expiresAt: Date;
  /** The normalized `refined_*` patch the paid answer produced, if stored. */
  traits?: Record<string, unknown> | null;
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
  }): Promise<RefineLedgerRow | null>;
  /** Provider CALLS charged to the window starting at `since`. */
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
    traits?: Record<string, unknown> | null;
    spendWindow: Date;
  }): Promise<void>;
  ingest(input: RefineIngestInput): Promise<void>;
  /** First instant of the budget window containing `at` (UTC calendar month). */
  budgetWindowStart(at: Date): Date;
  /**
   * Fire-and-forget outbound `contact.refined` emit. SYNCHRONOUS and
   * `void`-returning by contract: the chain must not await it, so an outbound
   * problem can never slow or fail a refinement. Optional — a caller with no
   * db/hatchet (a test, a pure driver) omits it and the chain is unchanged.
   */
  emitRefined?(input: RefineEmitInput): void;
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
 * never be conditional on a live DB read, and its KEY must never contain one.
 * The law is written out at `lib/feed.ts:152-165`; the corrected shape is
 * `lib/connector-actions.ts:320-381` and this function mirrors it exactly.
 *
 * Refinement is the WORST case for the law, which is why the structure below is
 * not negotiable. TWO live reads want to sit in front of the memo and neither
 * may:
 *
 *  - the ledger gate reads the very row this function's own final step writes,
 *    so a naive "check the ledger, early-return `cached`, otherwise memoize"
 *    would issue the durable call on the first run and NOT on the replay — not
 *    racily, but on EVERY replay;
 *  - resolving the SUBJECT is a live `contacts` read, and refinement is the one
 *    function in the engine whose whole purpose is to be called after a wait —
 *    exactly when the row has had time to gain an email (a form fill, an
 *    identify, a merge). With eviction live, replay-from-top is the NORMAL
 *    resume after every long sleep, so the divergence window is the whole
 *    sleep, and an anonymous-then-identified contact would issue ZERO memos on
 *    the run and ONE on the replay.
 *
 * So:
 *
 *  - Step 0 is a PURE ARGUMENT check: with no `contactId`/`email`/`userId` at
 *    all there is nothing to refine and nothing to key from. It reads no
 *    database, so it cannot diverge, and returning `no_lookup_key` before the
 *    memo is safe.
 *  - Step 1 (no active provider) is a boot-time config read — also genuinely
 *    replay-stable, also safe outside.
 *  - Then `withDurableGate` OWNS the rest of the shape structurally (it is this
 *    function's former hand-rolled block, extracted): whenever a journey
 *    boundary exists it UNCONDITIONALLY derives the key from the CALLER'S
 *    ARGUMENTS ONLY (the branded `CallerRef` makes anything else a type
 *    error), `registerKey`s it, and issues `boundary.memoize`. No condition
 *    guards that call.
 *  - Steps 2-6 (resolve, ledger gate, budget cap, provider call, ledger write +
 *    ingest) ALL live INSIDE the memo closure, so EVERY verdict — including
 *    `no_lookup_key` — is recorded by the durable memo and replayed verbatim.
 *  - With NO boundary (a webhook, a cron, a test) the chain runs directly with
 *    no memo at all, exactly as `connector-actions.ts:342` does. Layer 2 — the
 *    `enrichment_lookups` unique index — carries exactly-once on its own there.
 */
export async function runRefineChain(
  deps: RefineChainDeps,
  opts: RefineContactOptions,
): Promise<RefineContactResult> {
  // ---- (0) Pure ARGUMENT check. No DB. Safe outside the memo. ---------------
  // `callerRef` is also the memo discriminant: authored input, never a resolved
  // one. `deriveJourneyKey`'s contract is that the key contains no wall-clock
  // and no live-DB-read result (journey-boundary.ts) — a lookup key resolved
  // off `contacts` would break that, and a domain→email upgrade mid-sleep would
  // silently re-key the memo AND the ledger row, double-charging the vendor.
  const callerRef = refineCallerRef(opts);
  if (!callerRef) return { status: "skipped", reason: "no_lookup_key" };

  // ---- (1) No active provider. OUTSIDE the memo (a config read). -----------
  const provider = deps.provider;
  const providerId = deps.providerId ?? provider?.meta.id;
  if (!provider || !providerId) {
    return { status: "skipped", reason: "no_provider" };
  }

  // boundary resolution → key derivation → registerKey → memoize is owned by
  // `withDurableGate`, which is the extraction of the block that used to live
  // right here — the ordering is structural now, not this function's to write.
  return withDurableGate(
    { kind: "refine", callerRef, idempotencyLabel: opts.idempotencyLabel },
    (idempotencyKey?: string) =>
      runGates({ deps, opts, provider, providerId, idempotencyKey }),
  );
}

/**
 * The caller's own reference to the subject, normalized — the ONLY input the
 * replay key is allowed to be derived from. Precedence mirrors
 * `resolveRefineTarget`'s specificity order, but every leg is an argument the
 * journey authored, so it is identical on a run and its replay (Hatchet
 * re-derives task input from the recorded payload).
 */
function refineCallerRef(opts: RefineContactOptions): CallerRef | undefined {
  const contactId = callerRefFromArgs(opts.contactId);
  if (contactId) return contactId;
  // Mirrors `normalizeEmail` (contacts.ts) without importing the db layer into
  // what must stay a pure, database-free module.
  const email = callerRefFromArgs(opts.email?.toLowerCase());
  if (email) return email;
  return callerRefFromArgs(opts.userId);
}

/**
 * Steps 2-6 — everything stateful, and therefore everything that must be
 * RECORDED by the memo rather than re-derived on a replay. Cheap-before-spend
 * ordering still holds; it just holds inside the closure.
 */
async function runGates(args: {
  deps: RefineChainDeps;
  opts: RefineContactOptions;
  provider: EnrichmentProvider;
  providerId: string;
  idempotencyKey?: string;
}): Promise<RefineContactResult> {
  const { deps, opts, provider, providerId } = args;

  // ---- (2) Resolve the subject + the lookup key. INSIDE the memo. ----------
  // A live `contacts` read, so the verdict it produces — including the
  // `no_lookup_key` skip — is memo-recorded and replayed verbatim.
  const target = await deps.resolveTarget(opts);
  const email = target?.email?.trim() || undefined;
  const domain = target?.domain?.trim() || undefined;
  const lookupKey = email ?? domain;
  if (!target || !lookupKey) {
    return { status: "skipped", reason: "no_lookup_key" };
  }
  const lookupKind: EnrichmentLookupKind = email ? "email" : "domain";

  // ---- (3) Ledger gate — TTL cache + negative cache. Zero spend. -----------
  if (!opts.force) {
    const row = await deps.findLedgerRow({
      provider: providerId,
      lookupKind,
      lookupKey,
    });
    if (row && row.expiresAt.getTime() > deps.now().getTime()) {
      // A `found` row is a PAID positive answer. The ledger is keyed by
      // (provider, kind, key) with NO contact dimension, and a `domain` key is
      // shared by every contact at that company — so "already paid for" and
      // "this contact already has the traits" are different questions. Land the
      // stored patch on WHOEVER is being asked about, then return `cached`.
      if (row.status === "found") {
        return landCachedTraits({
          deps,
          providerId,
          target,
          row,
          ...(args.idempotencyKey
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      }
      // A `not_found` row is a PAID negative answer — a miss costs money too.
      if (row.status === "not_found") return { status: "not_found" };
      // `error` deliberately falls through: it is not a paid result, so it must
      // never suppress a retry (AC 7).
    }
  }

  // ---- (4) Budget cap. Fails CLOSED; `force` does not bypass it. -----------
  // Counts provider CALLS in the window, not ledger rows: the row is one per
  // subject and `force` updates it in place, so a row count would let a force
  // loop on one key spend without limit.
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
    // triggered it. Record the SPEND (the request left the building, so the cap
    // must see it) and return a skip.
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
        traits: null,
        spendWindow: deps.budgetWindowStart(failedAt),
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
  const properties = flattenTraits(result, {
    provider: providerId,
    refinedAt,
  });

  // The ledger row carries the NORMALIZED patch, not just the vendor's `raw`:
  // `raw` is vendor-shaped and the engine cannot re-flatten it without the
  // provider, so without this a later cache hit for a DIFFERENT contact sharing
  // the key would have nothing to land.
  await deps.writeLedgerRow({
    provider: providerId,
    lookupKind,
    lookupKey,
    status: result.found ? "found" : "not_found",
    contactId: target.contactId ?? null,
    refinedAt,
    expiresAt: new Date(refinedAt.getTime() + deps.ttlDays * MS_PER_DAY),
    raw: result.raw,
    traits: result.found ? properties : null,
    spendWindow: deps.budgetWindowStart(refinedAt),
  });

  const landed = await landTraits({
    deps,
    target,
    properties,
    providerId,
    found: result.found,
    cached: false,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  if (!landed) return { status: "skipped", reason: "ingest_failed" };
  if (!result.found) return { status: "not_found" };

  // ---- (7) OUTBOUND `contact.refined`. The ONLY emission site. -------------
  // Placed here on purpose: on the already-decided `refined` verdict, AFTER
  // every stateful step, INSIDE the gate closure. It issues no durable call and
  // sits nowhere near the gate's own ordering, so the journal is byte-identical
  // with and without it — and on an eviction-capable replay the closure is not
  // re-entered at all, so the event is not re-emitted either.
  //
  // Deliberately NOT emitted for `cached` / `not_found` / `skipped`: a cache hit
  // spends nothing and changes nothing a subscriber did not already hear about.
  //
  // The dep is void-returning, so nothing here is awaited and an outbound
  // failure cannot touch this result.
  deps.emitRefined?.({
    ...(target.userId ? { userId: target.userId } : {}),
    ...(target.email ? { email: target.email } : {}),
    ...(target.contactId ? { contactId: target.contactId } : {}),
    provider: providerId,
    // VENDOR facts only — `refined_at` / `refined_provider` are provenance and
    // are dropped. Two reasons, both deliberate: the envelope already carries
    // both as top-level `at` / `provider`, so keeping them here would say the
    // same thing twice; and `flattenTraits` stamps them UNCONDITIONALLY, so a
    // found-but-empty vendor answer would otherwise report two changed traits
    // when nothing about the person changed. `traits: []` now says that
    // honestly.
    traitKeys: Object.keys(properties)
      .filter((key) => !REFINED_META_KEYS.includes(key))
      .sort(),
    refinedAt,
    dedupeKey: refineOutboundDedupeKey({
      provider: providerId,
      lookupKind,
      lookupKey,
      refinedAt,
    }),
  });

  return { status: "refined", properties };
}

/**
 * A cache HIT on a key that may well have been paid for by a DIFFERENT contact.
 *
 * `cached` means exactly one thing: THIS LOOKUP KEY WAS ALREADY PAID FOR. The
 * spend contract (AC 2) is untouched — zero provider calls, zero new ledger
 * rows — but the OUTCOME is no longer suppressed along with the spend. The
 * stored patch is landed on the contact being asked about, so the GTM loop
 * closes for the second, third and hundredth contact at the same company, not
 * just the one that paid.
 *
 * The ingest runs even when the contact already carries every trait, because
 * the property merge is not the point: `checkBucketMembership` re-runs ONLY on
 * the ingest path (DECISIONS §3.3), and a contact can hold the traits while its
 * membership was never evaluated — which is precisely the state a failed ingest
 * leaves behind. That makes the retry after an `ingest_failed` free.
 *
 * Rows written before the `traits` column existed have nothing stored; those
 * fall back to the caller's own traits, which is exactly the old behaviour.
 */
async function landCachedTraits(args: {
  deps: RefineChainDeps;
  providerId: string;
  target: RefineTarget;
  row: RefineLedgerRow;
  idempotencyKey?: string;
}): Promise<RefineContactResult> {
  const { deps, target, row } = args;
  const stored = row.traits ?? undefined;
  if (!stored) {
    return { status: "cached", properties: target.refinedProperties ?? {} };
  }

  const landed = await landTraits({
    deps,
    target,
    properties: stored,
    providerId: args.providerId,
    found: true,
    cached: true,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  // A failed ingest on a cache hit costs nothing to retry: the ledger row (and
  // its stored patch) stays exactly as it is, so the NEXT call hits this same
  // branch and lands the traits for free.
  if (!landed) return { status: "skipped", reason: "ingest_failed" };

  return { status: "cached", properties: stored };
}

/**
 * THROUGH `ingestEvent`, never `resolveOrCreateContact`: only the ingest path
 * re-runs `checkBucketMembership`, and that synchronous re-evaluation is the
 * entire point — it is what turns a fit trait into a bucket transition.
 *
 * Returns false when the ingest failed. The throw is swallowed deliberately:
 * refinement must never fail the journey run or the ingest that triggered it,
 * and by this point a paid ledger row is already committed — letting the
 * exception escape would spend the money AND kill the run.
 */
async function landTraits(args: {
  deps: RefineChainDeps;
  target: RefineTarget;
  properties: Record<string, unknown>;
  providerId: string;
  found: boolean;
  cached: boolean;
  idempotencyKey?: string;
}): Promise<boolean> {
  const { deps, target } = args;
  try {
    await deps.ingest({
      ...(target.userId ? { userId: target.userId } : {}),
      ...(target.email ? { email: target.email } : {}),
      ...(target.contactId ? { contactId: target.contactId } : {}),
      eventProperties: {
        provider: args.providerId,
        found: args.found,
        cached: args.cached,
      },
      contactProperties: args.properties,
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    });
    return true;
  } catch (error) {
    deps.logger.error("refineContact: could not land the refined traits", {
      provider: args.providerId,
      cached: args.cached,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The per-endpoint delivery dedupe key for `contact.refined`.
 *
 * The LEDGER ROW'S IDENTITY — `(provider, lookupKind, lookupKey)`, the
 * `enrichment_lookups` unique triple — PLUS the lookup instant of the answer
 * being announced.
 *
 * The instant is load-bearing, not decoration. `webhook_deliveries` carries a
 * unique `(endpointId, dedupeKey)` index (schema/webhook-deliveries.ts) and
 * nothing in the engine ever deletes a delivery row, so a key that is only the
 * triple is PERMANENT: a contact refined today, re-refined in 90 days when
 * `ENRICHMENT_TTL_DAYS` expires and the vendor reports a new job title, would
 * recompute a byte-identical key and the subscriber would never be told —
 * which is precisely the event a CRM sync exists to receive. Same for any
 * `force: true` refresh.
 *
 * That costs nothing on the re-drive side, because the instant is not what
 * defends a re-drive: the LEDGER GATE is. A retry of the same refinement finds
 * the row the first attempt wrote, returns `cached`, and never reaches the
 * emit at all. The dedupe is the backstop for the narrow race where two
 * concurrent lookups of one subject both pass that gate — and for the truly
 * identical answer (same `refinedAt`) it still holds exactly.
 *
 * `toISOString()` because the key must be byte-stable: a locale string is not.
 */
export function refineOutboundDedupeKey(input: {
  provider: string;
  lookupKind: EnrichmentLookupKind;
  lookupKey: string;
  refinedAt: Date;
}): string {
  const at = input.refinedAt.toISOString();
  return `refine:${input.provider}:${input.lookupKind}:${input.lookupKey}:${at}`;
}
