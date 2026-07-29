import { contacts, type Database } from "@hogsend/db";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import {
  contactKey,
  lookupContactIdByKey,
  normalizeEmail,
} from "./contacts.js";
import { getDb } from "./db.js";
import {
  countEnrichmentLookups,
  findEnrichmentLookup,
  startOfUtcMonth,
  upsertEnrichmentLookup,
} from "./enrichment-ledger.js";
import {
  getEnrichmentProvider,
  getEnrichmentProviderRegistry,
} from "./enrichment-registry-singleton.js";
import { hatchet } from "./hatchet.js";
import { ingestEvent } from "./ingestion.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import {
  REFINE_EVENT,
  type RefineChainDeps,
  type RefineContactOptions,
  type RefineContactResult,
  type RefineTarget,
  runRefineChain,
} from "./refine-chain.js";

export type {
  RefineContactOptions,
  RefineContactResult,
} from "./refine-chain.js";
export { REFINE_EVENT } from "./refine-chain.js";

const logger = createLogger(process.env.LOG_LEVEL);

/** `contacts.id` is a uuid; only compare against it for a uuid-shaped ref. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refinement — the one new public function of this release. Resolves a contact,
 * spends AT MOST one provider lookup, and lands the vendor's answer on the
 * CANONICAL contact-property fields (fill-if-absent, so first-party data is
 * never overwritten) THROUGH `ingestEvent`, so bucket membership re-evaluates
 * synchronously and the GTM loop closes:
 *
 * ```
 * behaviour → bucket("gtm-high-intent").on("enter")
 *           → refineContact()
 *           → contacts.properties.{company_employees, seniority, …} (via ingestEvent)
 *           → checkBucketMembership re-runs
 *           → bucket("gtm-qualified", b => b.prop("company_employees").gte(100))
 * ```
 *
 * A STANDALONE import, never a `ctx` method — the journey context stays
 * orchestration primitives only, exactly like `sendEmail()` and `sendSms()`.
 *
 * Replay-safety is two-layer. Layer 1 is Hatchet's durable `memo`, keyed by
 * `deriveJourneyKey({ kind: "refine", … })` over the CALLER'S ARGUMENTS ONLY and
 * issued UNCONDITIONALLY whenever a journey boundary exists — see the law
 * spelled out on `runRefineChain`. Layer 2 is the `enrichment_lookups` unique
 * index, which carries exactly-once on its own outside a journey.
 *
 * It NEVER throws. A vendor 5xx writes an `error` ledger row (which records the
 * spend but does not suppress a later retry) and returns
 * `{ status: "skipped", reason: "provider_error" }`; a failed ingest returns
 * `{ status: "skipped", reason: "ingest_failed" }` rather than escaping into the
 * journey run that called it.
 */
export async function refineContact(
  opts: RefineContactOptions = {},
): Promise<RefineContactResult> {
  const db = getDb();

  // An explicit `provider` id overrides the container's active provider; an id
  // that resolves to nothing is a `no_provider` skip, not a throw.
  const active = getEnrichmentProvider();
  const provider = opts.provider
    ? getEnrichmentProviderRegistry()?.get(opts.provider)
    : active;

  const deps: RefineChainDeps = {
    ...(provider ? { provider, providerId: provider.meta.id } : {}),
    ttlDays: readPositiveInt(process.env.ENRICHMENT_TTL_DAYS, 90),
    monthlyCap: readPositiveInt(process.env.ENRICHMENT_MONTHLY_LOOKUPS, 0),
    now: () => new Date(),
    logger,
    budgetWindowStart: startOfUtcMonth,
    resolveTarget: (target) => resolveRefineTarget(db, target),
    findLedgerRow: async (input) => {
      const row = await findEnrichmentLookup({ db, ...input });
      return row
        ? { status: row.status, expiresAt: row.expiresAt, traits: row.traits }
        : null;
    },
    countLookupsSince: (input) =>
      countEnrichmentLookups({ db, since: input.since }),
    writeLedgerRow: (input) => upsertEnrichmentLookup({ db, ...input }),
    // OUTBOUND `contact.refined` — fire-and-forget, exactly the `bucket.entered`
    // shape (bucket-emit.ts). `emitOutbound` never throws; the `.catch` is
    // defence-in-depth so a webhook problem can never fail a refinement.
    emitRefined: (input) => {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "contact.refined",
        dedupeKey: input.dedupeKey,
        payload: {
          userId: input.userId ?? null,
          email: input.email ?? null,
          contactId: input.contactId ?? null,
          provider: input.provider,
          traits: input.traitKeys,
          at: input.refinedAt.toISOString(),
        },
      }).catch(logger.warn);
    },
    ingest: async (input) => {
      await ingestEvent({
        db,
        registry: getJourneyRegistrySingleton(),
        hatchet,
        logger,
        event: {
          event: REFINE_EVENT,
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.email ? { userEmail: input.email } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
          eventProperties: input.eventProperties,
          contactProperties: input.contactProperties,
          ...(input.touchProperties
            ? { touchProperties: input.touchProperties }
            : {}),
          source: "enrichment",
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
      });
    },
  };

  return runRefineChain(deps, opts);
}

/**
 * Resolve the refinement subject and everything the lookup needs from it: the
 * canonical key the ingest writes back under, the lookup key (email first, then
 * the contact's company domain), the vendor query's name/company hints, and the
 * row's existing properties (which fill-if-absent reads at landing time to
 * decide which vendor facts to keep).
 *
 * An email with no contact row is still refinable — the ingest at the end of the
 * chain creates the contact — so a brand-new address is not a `no_lookup_key`.
 */
async function resolveRefineTarget(
  db: Database,
  opts: RefineContactOptions,
): Promise<RefineTarget | null> {
  const email = opts.email ? normalizeEmail(opts.email) : undefined;
  const userId = opts.userId?.trim() || undefined;
  const row = await findContactRow(db, {
    contactId: opts.contactId,
    email,
    userId,
  });

  if (!row) {
    // No row yet: an email is still a perfectly good lookup key.
    if (!email) return null;
    return { email, ...(userId ? { userId } : {}) };
  }

  const properties = row.properties ?? {};
  const resolvedEmail = row.email ?? email;
  // REPLAY SAFETY: the domain this picks must be STABLE across a run and its
  // replay. The domain becomes the `lookupKey`, which is the `enrichment_lookups`
  // arbiter — Layer 2, the version-independent exactly-once backstop. (Layer 1,
  // the memo key, is derived from the caller's arguments alone and is immune.)
  // A source that refinement itself changes between the run and the replay would
  // derive a DIFFERENT ledger key, miss the row it just wrote, and charge the
  // vendor a second time.
  //
  // `company_domain` is the key `flattenTraits` WRITES (the vendor's canonical
  // domain, which need not equal the one we looked up by), so it is listed LAST.
  // That ordering — externally-supplied `companyDomain`/`domain` before the
  // refinement-written `company_domain` — is what keeps the pick stable: the only
  // way refinement can FILL `company_domain` is fill-if-absent (it was absent),
  // and whenever it is the pick it was already present (so fill-if-absent leaves
  // it untouched). A domain-only contact looked up by `domain` keeps resolving
  // via `domain` even after the vendor fills `company_domain`, because `domain`
  // outranks it.
  const domain = readString(
    properties,
    "companyDomain",
    "domain",
    "company_domain",
  );

  return {
    contactId: row.id,
    userId: contactKey(row),
    ...(resolvedEmail ? { email: resolvedEmail } : {}),
    // Email is the higher-signal key, so a domain is only the lookup subject
    // when there is no email at all.
    ...(!resolvedEmail && domain ? { domain } : {}),
    ...spread("firstName", readString(properties, "firstName", "first_name")),
    ...spread("lastName", readString(properties, "lastName", "last_name")),
    ...spread(
      "company",
      readString(properties, "company", "company_name", "companyName"),
    ),
    existingProperties: properties,
  };
}

type ContactRow = typeof contacts.$inferSelect;

/** Live-row lookup by the most specific key the caller supplied. */
async function findContactRow(
  db: Database,
  keys: { contactId?: string; email?: string; userId?: string },
): Promise<ContactRow | null> {
  const live = async (where: SQL | undefined): Promise<ContactRow | null> => {
    const rows = await db
      .select()
      .from(contacts)
      .where(and(where, isNull(contacts.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  };

  if (keys.contactId && UUID.test(keys.contactId)) {
    const row = await live(eq(contacts.id, keys.contactId));
    if (row) return row;
  }
  if (keys.email) {
    const row = await live(eq(contacts.email, keys.email));
    if (row) return row;
  }
  if (keys.userId) {
    // `userId` is the canonical key — external_id ?? anonymous_id ?? id — and
    // `lookupContactIdByKey` owns that whole precedence: the three identity
    // columns (uuid leg regex-guarded) and then the identity table. The alias
    // leg is the new behaviour: a MERGED-AWAY key refines the SURVIVOR instead
    // of missing (the loser's row is soft-deleted, invisible to any column
    // probe). A key nothing owns still resolves nothing — the caller's
    // email-only fallback above is untouched.
    const contactId = await lookupContactIdByKey(db, keys.userId);
    if (contactId) {
      const row = await live(eq(contacts.id, contactId));
      if (row) return row;
    }
  }
  return null;
}

/** `{ [field]: value }` when `value` is set, else `{}` — a typed spread hatch. */
function spread<K extends "firstName" | "lastName" | "company">(
  field: K,
  value: string | undefined,
): Partial<RefineTarget> {
  return value ? ({ [field]: value } as Partial<RefineTarget>) : {};
}

/** First non-empty string among `keys`, or undefined. */
function readString(
  properties: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Read a non-negative integer knob from the live `process.env` at CALL time,
 * with the same coercion + default `env.ts` declares (which stays the schema
 * authority). Mirrors `holdout.ts`'s `GLOBAL_CONTROL_PERCENT` read: a live read
 * lets an operator retune the enrichment budget without a redeploy.
 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
