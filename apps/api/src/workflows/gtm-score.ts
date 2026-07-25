import { createDatabase, type Database } from "@hogsend/db";
import {
  createLogger,
  getJourneyRegistrySingleton,
  hatchet,
  ingestEvent,
  runBatchedBackfill,
} from "@hogsend/engine";
import { sql } from "drizzle-orm";
import { Events } from "../journeys/constants/index.js";

// ===========================================================================
// 1. THE SCORE — a pure function of current contact state.
// ===========================================================================

/**
 * Everything the score is allowed to look at. The fit fields are typed `unknown`
 * on purpose: they come straight out of the `contacts.properties` jsonb bag,
 * which can hold anything a provider or an operator put there. The guards below
 * are the whole reason this input is not typed optimistically.
 *
 * `daysSinceLastActivity` is passed IN rather than derived from the clock. That
 * is what makes the function deterministic and therefore testable: decay is an
 * argument, not a side channel.
 */
export interface GtmScoreInput {
  /** `refined_seniority` — Apollo's vocabulary (owner/founder/c_suite/vp/…). */
  refinedSeniority?: unknown;
  /** `refined_company_employees` — MUST be a real JSON number to count. */
  refinedCompanyEmployees?: unknown;
  /** `refined_company_industry`. */
  refinedCompanyIndustry?: unknown;
  /** `refined_company_domain` — presence alone is a weak fit signal. */
  refinedCompanyDomain?: unknown;
  /** Count of `key.action` in the behaviour window. */
  keyActions: number;
  /** Count of `feature.used` in the behaviour window. */
  featureUses: number;
  /** Count of `paid_feature.attempted` in the behaviour window. */
  paidFeatureAttempts: number;
  /** Count of `email.link_clicked` in the behaviour window. */
  emailLinkClicks: number;
  /** Days since the contact's most recent event; `null` when there is none. */
  daysSinceLastActivity: number | null;
}

/**
 * Seniority bands. Apollo's `seniority` vocabulary, lowercased. Anything not
 * listed (senior / entry / intern / a value we have never seen) pays nothing —
 * silence is not a signal.
 */
const SENIORITY_POINTS: Record<string, number> = {
  owner: 20,
  founder: 20,
  c_suite: 20,
  "c-suite": 20,
  cxo: 20,
  partner: 20,
  vp: 20,
  head: 12,
  director: 12,
  manager: 6,
  lead: 6,
};

/** Industries this product actually sells into. Lowercased exact match. */
const TARGET_INDUSTRIES = new Set([
  "computer software",
  "information technology & services",
  "internet",
  "saas",
  "software",
]);

/**
 * The weights, in one place so a reader can retune without reading the code.
 *
 * FIT — from the `refined_*` traits `refineContact()` landed. Max 50.
 *   seniority band            0 / 6 / 12 / 20
 *   company size band         0 / 4 / 8 / 12 / 15
 *   target industry           0 / 10
 *   known company domain      0 / 5
 *
 * BEHAVIOUR — event counts over the window. Each axis is capped so one loud
 * signal cannot dominate. Max 50 before decay.
 *   key actions               min(n, 10) x 2   → 0..20
 *   feature uses              min(n, 5)  x 2   → 0..10
 *   paid-feature attempts     min(n, 2)  x 6   → 0..12
 *   email link clicks         min(n, 4)  x 2   → 0..8
 *
 * DECAY — a recency multiplier applied to the BEHAVIOUR half only. Fit does not
 * go stale on the same timescale as intent; a VP at a 250-person software
 * company is still a VP at a 250-person software company next month.
 *   idle <= 7d → 1.0 · <= 14d → 0.75 · <= 30d → 0.5 · beyond / never → 0
 *
 * TOTAL = fit + round(behaviour x decay), clamped to 0..100. `gtm-qualified`
 * fires at 20, which a strong fit clears on its own and a purely behavioural
 * contact reaches only with sustained, recent usage.
 */
const BEHAVIOUR_CAPS = {
  keyActions: { cap: 10, weight: 2 },
  featureUses: { cap: 5, weight: 2 },
  paidFeatureAttempts: { cap: 2, weight: 6 },
  emailLinkClicks: { cap: 4, weight: 2 },
} as const;

/** A jsonb bag holds anything. Only a real, finite JSON number counts. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Same discipline for strings: only a real string is normalised. */
function lowerString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().toLowerCase()
    : null;
}

/** Clamp a possibly-junk count into `[0, cap]`. */
function cappedCount(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, cap);
}

function fitPoints(input: GtmScoreInput): number {
  let points = 0;

  const seniority = lowerString(input.refinedSeniority);
  if (seniority) points += SENIORITY_POINTS[seniority] ?? 0;

  // The number guard is load-bearing, not defensive noise: a stringified "250"
  // in the jsonb bag would otherwise compare with `>=` by lexicographic luck.
  const employees = finiteNumber(input.refinedCompanyEmployees);
  if (employees !== null) {
    if (employees >= 1000) points += 15;
    else if (employees >= 200) points += 12;
    else if (employees >= 50) points += 8;
    else if (employees >= 10) points += 4;
  }

  const industry = lowerString(input.refinedCompanyIndustry);
  if (industry && TARGET_INDUSTRIES.has(industry)) points += 10;

  if (lowerString(input.refinedCompanyDomain)) points += 5;

  return points;
}

function behaviourPoints(input: GtmScoreInput): number {
  return (
    cappedCount(input.keyActions, BEHAVIOUR_CAPS.keyActions.cap) *
      BEHAVIOUR_CAPS.keyActions.weight +
    cappedCount(input.featureUses, BEHAVIOUR_CAPS.featureUses.cap) *
      BEHAVIOUR_CAPS.featureUses.weight +
    cappedCount(
      input.paidFeatureAttempts,
      BEHAVIOUR_CAPS.paidFeatureAttempts.cap,
    ) *
      BEHAVIOUR_CAPS.paidFeatureAttempts.weight +
    cappedCount(input.emailLinkClicks, BEHAVIOUR_CAPS.emailLinkClicks.cap) *
      BEHAVIOUR_CAPS.emailLinkClicks.weight
  );
}

/** The decay multiplier. Derived ONLY from the explicit argument. */
function recencyFactor(daysSinceLastActivity: number | null): number {
  const days = finiteNumber(daysSinceLastActivity);
  if (days === null) return 0;
  if (days <= 7) return 1;
  if (days <= 14) return 0.75;
  if (days <= 30) return 0.5;
  return 0;
}

/**
 * RECOMPUTE, NEVER INCREMENT. This returns the contact's whole score from its
 * whole current state — it never reads the previous score and never adds to it.
 * That is not a style preference: `mergePropertiesSql` only overwrites with a
 * literal (there is no SQL-side `+`), so a read-modify-write increment silently
 * loses every concurrent update. A pure recompute dissolves the problem, makes
 * decay trivial, and is replay-safe by construction.
 *
 * No clock, no randomness, no I/O, no mutation of the input. Same input in,
 * same number out, forever.
 */
export function computeGtmScore(input: GtmScoreInput): number {
  const fit = fitPoints(input);
  const behaviour =
    behaviourPoints(input) * recencyFactor(input.daysSinceLastActivity);
  const total = fit + Math.round(behaviour);
  return Math.max(0, Math.min(100, total));
}

// ===========================================================================
// 2. THE NIGHTLY RECOMPUTE — batched, resumable, terminating.
// ===========================================================================

/** How far back the behavioural counts look. */
const BEHAVIOUR_WINDOW_DAYS = 30;

const BATCH_SIZE = 250;

/** One row of the batch query: the contact plus its windowed event counts. */
export interface ScoreRow {
  id: string;
  user_key: string;
  properties: Record<string, unknown> | null;
  key_actions: number;
  feature_uses: number;
  paid_feature_attempts: number;
  email_link_clicks: number;
  days_since_last_activity: number | null;
}

/**
 * One keyset page of contacts plus their windowed behaviour counts.
 *
 * EXPORTED so a test can drive the REAL query against a real Postgres. This SQL
 * is where the subtle mistakes live — the recency filter below, the identity
 * `COALESCE`, the cursor — and none of it is reachable through
 * `computeGtmScore`. An inline query would be untestable without booting the
 * whole Hatchet task.
 */
export async function selectScoreBatch(
  database: Database,
  opts: { limit: number; cursor: string; now: Date; windowStart: Date },
): Promise<ScoreRow[]> {
  const { limit, cursor, now, windowStart } = opts;
  return (await database.execute(sql`
    WITH batch AS (
      SELECT id, external_id, anonymous_id, properties
      FROM contacts
      WHERE deleted_at IS NULL
        AND id > ${cursor}::uuid
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    SELECT
      b.id::text AS id,
      COALESCE(b.external_id, b.anonymous_id, b.id::text) AS user_key,
      b.properties AS properties,
      COUNT(*) FILTER (
        WHERE e.event = ${Events.KEY_ACTION}
      )::int AS key_actions,
      COUNT(*) FILTER (
        WHERE e.event = ${Events.FEATURE_USED}
      )::int AS feature_uses,
      COUNT(*) FILTER (
        WHERE e.event = ${Events.PAID_FEATURE_ATTEMPTED}
      )::int AS paid_feature_attempts,
      COUNT(*) FILTER (
        WHERE e.event = ${Events.EMAIL_LINK_CLICKED}
      )::int AS email_link_clicks,
      -- FILTERED to the four events the score actually reads. An unfiltered MAX
      -- would include gtm.scored -- the row THIS JOB writes -- so every scored
      -- contact would look active as of its own last scoring, resetting decay to
      -- ~0 on the next run and inflating the behaviour half of a score that has
      -- not moved. A metric that feeds a computation whose output resets that
      -- metric never settles.
      EXTRACT(
        EPOCH FROM (
          ${now.toISOString()}::timestamptz
          - MAX(e.occurred_at) FILTER (WHERE e.event IN (
              ${Events.KEY_ACTION},
              ${Events.FEATURE_USED},
              ${Events.PAID_FEATURE_ATTEMPTED},
              ${Events.EMAIL_LINK_CLICKED}
            ))
        )
      )::double precision / 86400 AS days_since_last_activity
    FROM batch b
    LEFT JOIN user_events e
      ON e.user_id = COALESCE(b.external_id, b.anonymous_id, b.id::text)
     AND e.occurred_at >= ${windowStart.toISOString()}::timestamptz
    GROUP BY b.id, b.external_id, b.anonymous_id, b.properties
    ORDER BY b.id
  `)) as unknown as ScoreRow[];
}

/**
 * Nightly blended re-score of every live contact.
 *
 * BATCH TERMINATION — the interesting decision. `runBatchedBackfill` stops when
 * a batch returns 0 and otherwise loops, which assumes each batch SHRINKS the
 * remaining set (the classic `WHERE new_col IS NULL` predicate). A recompute
 * does not shrink anything: a scored contact still matches "every contact", so
 * a naive `LIMIT 250` predicate would re-select the same first 250 rows forever.
 *
 * The fix is a KEYSET CURSOR on `contacts.id`. Each batch selects
 * `WHERE id > :cursor ORDER BY id LIMIT n` and advances the cursor to the last
 * id it saw, so the remaining set shrinks monotonically and the final batch
 * returns 0. A "scored-marker" column would also terminate, but it would need a
 * migration plus a reset pass every night — the cursor needs neither, and it is
 * naturally resumable: a crashed run simply restarts from the beginning and
 * re-derives the same scores, because the computation is pure.
 *
 * `runBatch` returns rows SCANNED, not rows written. Returning rows-written
 * would let a stretch of unchanged contacts return 0 and end the run early,
 * silently skipping every contact after them. That distinction is the bug this
 * job would otherwise ship with.
 *
 * SKIP-UNCHANGED — a contact whose recomputed score equals the stored one is
 * not written. Each write costs one `user_events` row plus a full ingest
 * round-trip (identity resolve, Hatchet push, exit checks, bucket re-evaluation),
 * so on a stable base the nightly cost is close to zero rather than one row per
 * contact per night. The tradeoff is honest in both directions: nothing changed,
 * so nothing is recorded, and the Events feed does not fill with no-ops. The
 * cost we DO pay — one `user_events` row per contact whose score MOVED — is
 * unavoidable, because `ingestEvent` is the only write path that re-runs
 * `checkBucketMembership`, and `gtm-qualified` is not time-based so the reconcile
 * cron will never evaluate it.
 *
 * `FOR UPDATE SKIP LOCKED` keeps two concurrent runs from selecting the same
 * rows at the same instant. The lock is released when the statement's implicit
 * transaction commits (the write happens later, through `ingestEvent`), so it is
 * not a mutual-exclusion guarantee — the real safety is that the recompute is
 * pure and idempotent: two runs landing on one contact compute the same number.
 */
export const gtmScoreTask = hatchet.task({
  name: "gtm-score",
  retries: 2,
  executionTimeout: "60m",
  // Nightly, off-peak. Override per-deploy without a code change.
  onCrons: [process.env.GTM_SCORE_CRON ?? "0 3 * * *"],
  fn: async () => {
    const { db, client } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const registry = getJourneyRegistrySingleton();

    // ONE clock read for the WHOLE run, taken here at the boundary. Every
    // contact in the run is then decayed against the same instant, so the run is
    // internally consistent and `computeGtmScore` stays clock-free.
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - BEHAVIOUR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    // Keyset cursor. The all-zero uuid sorts before every generated uuid.
    let cursor = "00000000-0000-0000-0000-000000000000";
    let scored = 0;

    try {
      const result = await runBatchedBackfill({
        db,
        logger,
        label: "contacts.gtmScore",
        batchSize: BATCH_SIZE,
        pauseMs: 50,
        runBatch: async (database, limit) => {
          const rows = await selectScoreBatch(database, {
            limit,
            cursor,
            now,
            windowStart,
          });

          if (rows.length === 0) return 0;
          cursor = rows[rows.length - 1]?.id ?? cursor;

          for (const row of rows) {
            const properties = row.properties ?? {};
            const gtmScore = computeGtmScore({
              refinedSeniority: properties.refined_seniority,
              refinedCompanyEmployees: properties.refined_company_employees,
              refinedCompanyIndustry: properties.refined_company_industry,
              refinedCompanyDomain: properties.refined_company_domain,
              keyActions: row.key_actions,
              featureUses: row.feature_uses,
              paidFeatureAttempts: row.paid_feature_attempts,
              emailLinkClicks: row.email_link_clicks,
              daysSinceLastActivity: row.days_since_last_activity,
            });

            // Skip-unchanged. An ABSENT score reads as 0, so the first run does
            // not write `gtmScore: 0` for every inert contact in the database —
            // an absent property and a stored 0 are equally unqualified
            // (`gte(20)` matches neither). A contact that FALLS to 0 from a real
            // stored score still gets written, because the stored value differs.
            // A junk stored value (a stringified "30") also differs from the
            // number, so the next run repairs it.
            if ((properties.gtmScore ?? 0) === gtmScore) continue;

            // THROUGH `ingestEvent`, never a direct `contacts` update: it is the
            // only write path that re-runs `checkBucketMembership`, which is what
            // flips `gtm-qualified`. `contactProperties` carries the score as a
            // real JSON number — `conditions/property.ts` does no coercion, so a
            // stringified score would never match `gte(20)`.
            await ingestEvent({
              db: database,
              registry,
              hatchet,
              logger,
              event: {
                event: Events.GTM_SCORED,
                userId: row.user_key,
                // THE PROVENANCE PIN, and it is not optional. `user_key` is
                // `COALESCE(external_id, anonymous_id, id::text)`, but
                // `resolveOrCreateContact` treats a bare `userId` as an
                // EXTERNAL key: it probes `external_id`, the `external`-kind
                // aliases, and a uuid-vs-`contacts.id` fallback — it never
                // probes `anonymous_id`. So a browser-SDK visitor who never
                // identified (anonymous_id set, external_id NULL) would resolve
                // to nothing and the resolver would MINT a phantom twin row
                // carrying the score, leaving the real contact at `{}` forever.
                // Worse, the real row's score would stay absent, so the
                // skip-unchanged guard below would never fire and the job would
                // re-mint nightly without ever converging.
                // `contactId` pins resolution to this exact row — no value
                // probe, no mint (contacts.ts `resolveByContactId`). It also
                // stops the email-only case (`user_key` = the uuid) from having
                // `fillInLink` stamp a synthetic `external_id` onto the contact
                // as a side effect of being scored.
                contactId: row.id,
                eventProperties: {
                  gtmScore,
                  previousGtmScore: properties.gtmScore ?? null,
                },
                contactProperties: { gtmScore },
                source: "gtm-score",
                // NO `idempotencyKey`, deliberately. A day-scoped key looks like
                // a retry guard and is really a trap: `ingestEvent` commits the
                // contact-property patch in step (1) but returns `stored: false`
                // from the dedupe in step (4) — BEFORE `checkBucketMembership`
                // in step (6). So a score that revisits a value already seen
                // that day would land the property and skip the membership
                // re-evaluation, leaving a contact reading 34 while absent from
                // `gtm-qualified`, with nothing to heal it (a pure `prop`
                // bucket is invisible to the reconcile cron by design).
                // The retry guard the key was reaching for already exists: a
                // Hatchet retry re-runs `fn` from a reset cursor, and every
                // contact already written has a stored score equal to the
                // recomputed one, so skip-unchanged returns before this call.
              },
            });
            scored += 1;
          }

          // Rows SCANNED — see the batch-termination note above.
          return rows.length;
        },
      });

      logger.info(
        `[gtm-score] ${scored} score(s) changed across ${result.rows} contact(s)`,
      );
      // A plain JSON object so Hatchet can serialize the task output.
      return {
        contacts: result.rows,
        scored,
        batches: result.batches,
        exhausted: result.exhausted,
      };
    } finally {
      await client.end({ timeout: 5 });
    }
  },
});
