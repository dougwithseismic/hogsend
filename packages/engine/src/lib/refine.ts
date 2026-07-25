import { contacts, type Database } from "@hogsend/db";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { contactKey, normalizeEmail } from "./contacts.js";
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
import {
  REFINE_EVENT,
  type RefineChainDeps,
  type RefineContactOptions,
  type RefineContactResult,
  type RefineTarget,
  runRefineChain,
} from "./refine-chain.js";
import { pickRefinedTraits } from "./refine-traits.js";

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
 * spends AT MOST one provider lookup, and lands the vendor's answer as flat
 * `refined_*` contact properties THROUGH `ingestEvent`, so bucket membership
 * re-evaluates synchronously and the GTM loop closes:
 *
 * ```
 * behaviour → bucket("gtm-high-intent").on("enter")
 *           → refineContact()
 *           → contacts.properties.refined_*        (via ingestEvent)
 *           → checkBucketMembership re-runs
 *           → bucket("gtm-qualified", b => b.prop("refined_company_employees").gte(100))
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
 * `refined_*` traits already on the row (what a cache hit compares against to
 * decide whether this contact still needs the stored answer landed).
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
  // REPLAY SAFETY: every key here must be one this function does NOT write.
  // The domain becomes the `lookupKey`, which is the `enrichment_lookups`
  // arbiter — Layer 2, the version-independent exactly-once backstop. (Layer 1,
  // the memo key, is derived from the caller's arguments alone and is immune.)
  // A self-referential source would make a replay derive a DIFFERENT ledger key,
  // miss the row it just wrote, and charge the vendor a second time.
  //
  // `refined_company_domain` is deliberately EXCLUDED: `flattenTraits` writes it
  // (refine-traits.ts) from the vendor's canonical domain, which need not equal
  // the one we looked up by. A contact carrying only `domain` would resolve via
  // `domain` on the original run, then — once `refined_company_domain` exists and
  // outranks it — resolve differently on replay, deriving a different memo key.
  // The three keys below are externally supplied and therefore replay-stable.
  const domain = readString(
    properties,
    "company_domain",
    "companyDomain",
    "domain",
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
      readString(
        properties,
        "company",
        "company_name",
        "companyName",
        "refined_company_name",
      ),
    ),
    refinedProperties: pickRefinedTraits(properties),
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
    // `userId` is the canonical key — external_id ?? anonymous_id ?? id — so
    // try each leg in that same precedence.
    const byExternal = await live(eq(contacts.externalId, keys.userId));
    if (byExternal) return byExternal;
    const byAnonymous = await live(eq(contacts.anonymousId, keys.userId));
    if (byAnonymous) return byAnonymous;
    if (UUID.test(keys.userId)) {
      const byId = await live(eq(contacts.id, keys.userId));
      if (byId) return byId;
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
