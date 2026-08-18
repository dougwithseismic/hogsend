import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";

/**
 * THE REFERRAL REPORT (PRD 05 §5.3). Model, window, depth and level weights
 * are REQUEST parameters; nothing weighted is persisted, so changing your mind
 * costs one query and backfills nothing.
 *
 * The whole tree walk is ONE recursive CTE. Doing it in TypeScript would mean
 * shipping every edge of every referrer to the process to multiply five
 * numbers, and the cycle guard (a referee who later refers an ancestor) would
 * have to be re-implemented over the wire. Postgres already has `ARRAY` and
 * `WITH RECURSIVE`.
 *
 * ## Currencies are never converted
 *
 * `conversions.value` carries `conversions.currency`, and this file has no FX
 * rate and no business asking for one. Every monetary answer is a LIST of
 * `{ currency, value }` pairs. The only place currency is flattened is the
 * beneficiary ORDER (a leaderboard needs one axis), and that is documented at
 * the sort itself rather than leaking into a returned number.
 */

/**
 * The referral model vocabulary. Deliberately NOT `@hogsend/attribution`'s
 * `ATTRIBUTION_MODELS`: that list is a marketing-touchpoint vocabulary
 * (`lastNonDirect`, `blended`, `positionU` vs `positionW`) whose ids do not
 * name the thing a referral edge is. These five are the models a referral
 * report can answer with the columns `referral_touches` actually has.
 */
export const REFERRAL_MODELS = [
  "first_touch",
  "last_touch",
  "linear",
  "time_decay",
  "position",
] as const;

export type ReferralModel = (typeof REFERRAL_MODELS)[number];

/** Time-decay half-life, matching `@hogsend/attribution`'s default. */
const TIME_DECAY_HALF_LIFE_DAYS = 7;

/** PRD 05 §5.3: the walk is capped, in the engine, at five levels. */
export const REFERRAL_REPORT_MAX_DEPTH = 5;

/** ISO 4217's "no currency" code - used when a conversion carries none. */
export const NO_CURRENCY = "XXX";

const MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

const WINDOW_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

export class InvalidWindowError extends Error {}

/**
 * Parse a duration string (`"30d"`, `"12h"`, `"90m"`) to milliseconds. The
 * window applies to the TOUCH -> BIND gap: an edge whose referee identified
 * later than this after the touch is not eligible for the report, whatever the
 * program's own `bindWindow` was when the row was written.
 */
export function parseWindowMs(input: string): number {
  const match = WINDOW_RE.exec(input.trim());
  if (!match) {
    throw new InvalidWindowError(
      `invalid window "${input}" - use <number><unit> with unit ` +
        "ms, s, m, h, d or w (for example 30d)",
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as keyof typeof MS | "ms";
  const ms = unit === "ms" ? value : value * MS[unit as keyof typeof MS];
  if (!(ms > 0)) {
    throw new InvalidWindowError(`window "${input}" is not positive`);
  }
  return ms;
}

/**
 * The level weight vector. Level 1 (the direct referrer) defaults to 1 and
 * every deeper level to 0, so adding `depth` WITHOUT adding weights widens the
 * tree counts but changes no revenue number.
 */
export function resolveLevelWeights(
  depth: number,
  weights: number[] | undefined,
): number[] {
  const out: number[] = [];
  for (let level = 1; level <= depth; level++) {
    const supplied = weights?.[level - 1];
    out.push(supplied ?? (level === 1 ? 1 : 0));
  }
  return out;
}

export interface CurrencyValue {
  currency: string;
  value: number;
}

export interface ReferralTreeLevel {
  level: number;
  /** Distinct referee contacts at this level of this beneficiary's tree. */
  referees: number;
  /** Conversions those referees fired inside `from`/`to`. */
  conversions: number;
  /** `levelWeight * edgeWeightProduct * conversion value`, per currency. */
  value: CurrencyValue[];
}

export interface ReferralBeneficiary {
  contactId: string;
  direct: { touched: number; bound: number; qualified: number };
  tree: ReferralTreeLevel[];
  /** The tree's value, summed across levels, per currency. */
  value: CurrencyValue[];
}

export interface ReferralReportOptions {
  db: Database;
  referralId: string;
  model: ReferralModel;
  /** Touch -> bind gap ceiling, in milliseconds. */
  windowMs: number;
  depth: number;
  /** One weight per level, index 0 = level 1. */
  levelWeights: number[];
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface ReferralReport {
  beneficiaries: ReferralBeneficiary[];
  /** Opaque cursor for the next page, or null at the end. */
  nextOffset: number | null;
}

interface TreeRow {
  beneficiary: string;
  level: number;
  referees: number;
  currency: string | null;
  conversions: number | null;
  value: number | null;
}

interface DirectRow {
  referrer: string;
  touched: number;
  bound: number;
  qualified: number;
}

/**
 * The eligible-edge + per-referee weighting CTE, shared by the report and the
 * tree drill-in. Emits `(referee, referrer, weight)` with each referee's
 * weights summing to 1.
 */
function edgesCte(opts: {
  referralId: string;
  model: ReferralModel;
  windowMs: number;
}) {
  const { referralId, model, windowMs } = opts;
  const windowSeconds = windowMs / 1000;
  const halfLifeSeconds = TIME_DECAY_HALF_LIFE_DAYS * 86_400;
  return sql`
    elig AS (
      SELECT t.id, t.referee_contact_id AS referee,
             t.referrer_contact_id AS referrer, t.touched_at
      FROM referral_touches t
      WHERE t.referral_id = ${referralId}
        AND t.referee_contact_id IS NOT NULL
        AND t.status IN ('bound', 'qualified')
        AND t.bound_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (t.bound_at - t.touched_at))
              <= ${windowSeconds}::float8
    ),
    ranked AS (
      SELECT e.*,
             row_number() OVER (
               PARTITION BY e.referee ORDER BY e.touched_at, e.id
             ) AS rn,
             count(*) OVER (PARTITION BY e.referee) AS n,
             max(e.touched_at) OVER (PARTITION BY e.referee) AS last_at
      FROM elig e
    ),
    scored AS (
      SELECT r.referee, r.referrer,
        CASE ${model}::text
          WHEN 'first_touch' THEN CASE WHEN r.rn = 1 THEN 1 ELSE 0 END
          WHEN 'last_touch' THEN CASE WHEN r.rn = r.n THEN 1 ELSE 0 END
          WHEN 'linear' THEN 1.0 / r.n
          WHEN 'time_decay' THEN power(
            0.5,
            EXTRACT(EPOCH FROM (r.last_at - r.touched_at))
              / ${halfLifeSeconds}::float8
          )
          WHEN 'position' THEN CASE
            WHEN r.n = 1 THEN 1
            WHEN r.n = 2 THEN 0.5
            WHEN r.rn = 1 OR r.rn = r.n THEN 0.4
            ELSE 0.2 / (r.n - 2)
          END
        END::float8 AS raw
      FROM ranked r
    ),
    edges AS (
      SELECT s.referee, s.referrer,
             s.raw / NULLIF(SUM(s.raw) OVER (PARTITION BY s.referee), 0)
               AS weight
      FROM scored s
      WHERE s.raw > 0
    )
  `;
}

/** `conversions` filtered to the report window, as `(referee, id, ...)`. */
function conversionsCte(from: Date | undefined, to: Date | undefined) {
  return sql`
    conv AS (
      SELECT c.contact_id AS referee, c.id,
             COALESCE(c.value, 0)::float8 AS value,
             COALESCE(c.currency, ${NO_CURRENCY}) AS currency
      FROM conversions c
      WHERE (${from ? sql`c.occurred_at >= ${from.toISOString()}::timestamptz` : sql`TRUE`})
        AND (${to ? sql`c.occurred_at <= ${to.toISOString()}::timestamptz` : sql`TRUE`})
    )
  `;
}

/**
 * Run the report. Two queries: the tree (one recursive CTE) and the direct
 * touch counts for the page's beneficiaries. The direct counts are deliberately
 * NOT model-filtered - "how many people did this person touch" is a fact about
 * the referrer, not about the model the reader picked today.
 */
export async function getReferralReport(
  opts: ReferralReportOptions,
): Promise<ReferralReport> {
  const { db, referralId, depth, levelWeights, from, to, limit, offset } = opts;

  const weightRows = levelWeights.map(
    (weight, i) => sql`(${i + 1}::int, ${weight}::float8)`,
  );

  const rows = (await db.execute(sql`
    WITH RECURSIVE
    ${edgesCte(opts)},
    lw(level, level_weight) AS (VALUES ${sql.join(weightRows, sql`, `)}),
    ${conversionsCte(from, to)},
    tree AS (
      SELECT e.referee, e.referrer AS beneficiary, 1 AS level,
             e.weight AS weight,
             ARRAY[e.referee, e.referrer] AS path
      FROM edges e
      UNION ALL
      SELECT t.referee, e.referrer, t.level + 1, t.weight * e.weight,
             t.path || e.referrer
      FROM tree t
      JOIN edges e ON e.referee = t.beneficiary
      WHERE t.level < ${depth}::int
        AND NOT (e.referrer = ANY(t.path))
    ),
    levels AS (
      SELECT t.beneficiary, t.level, count(DISTINCT t.referee)::int AS referees
      FROM tree t
      GROUP BY 1, 2
    ),
    vals AS (
      SELECT t.beneficiary, t.level, cv.currency,
             count(DISTINCT cv.id)::int AS conversions,
             SUM(cv.value * t.weight * lw.level_weight)::float8 AS value
      FROM tree t
      JOIN conv cv ON cv.referee = t.referee
      JOIN lw ON lw.level = t.level
      GROUP BY 1, 2, 3
    )
    SELECT l.beneficiary::text AS beneficiary, l.level, l.referees,
           v.currency, v.conversions, v.value
    FROM levels l
    LEFT JOIN vals v
      ON v.beneficiary = l.beneficiary AND v.level = l.level
    ORDER BY l.beneficiary, l.level
  `)) as unknown as { rows?: TreeRow[] } | TreeRow[];

  const treeRows: TreeRow[] = Array.isArray(rows) ? rows : (rows.rows ?? []);

  // Fold (beneficiary, level, currency) rows into the nested output shape.
  const byBeneficiary = new Map<string, Map<number, ReferralTreeLevel>>();
  for (const row of treeRows) {
    const levels =
      byBeneficiary.get(row.beneficiary) ??
      new Map<number, ReferralTreeLevel>();
    byBeneficiary.set(row.beneficiary, levels);
    const level = levels.get(row.level) ?? {
      level: row.level,
      referees: Number(row.referees),
      conversions: 0,
      value: [],
    };
    if (row.currency) {
      level.conversions += Number(row.conversions ?? 0);
      const value = Number(row.value ?? 0);
      if (value !== 0) {
        level.value.push({ currency: row.currency, value });
      }
    }
    levels.set(row.level, level);
  }

  const all: ReferralBeneficiary[] = [...byBeneficiary.entries()].map(
    ([contactId, levels]) => {
      const tree = [...levels.values()].sort((a, b) => a.level - b.level);
      const totals = new Map<string, number>();
      for (const level of tree) {
        for (const entry of level.value) {
          totals.set(
            entry.currency,
            (totals.get(entry.currency) ?? 0) + entry.value,
          );
        }
      }
      return {
        contactId,
        direct: { touched: 0, bound: 0, qualified: 0 },
        tree,
        value: [...totals.entries()]
          .map(([currency, value]) => ({ currency, value }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    },
  );

  // The leaderboard ORDER sums across currencies. That is a sort key, never a
  // returned number: no rate is applied and no converted total is exposed.
  all.sort((a, b) => {
    const sum = (x: ReferralBeneficiary) =>
      x.value.reduce((acc, v) => acc + v.value, 0);
    const delta = sum(b) - sum(a);
    return delta !== 0 ? delta : a.contactId.localeCompare(b.contactId);
  });

  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + limit < all.length ? offset + limit : null;

  if (page.length > 0) {
    const ids = page.map((b) => b.contactId);
    const direct = (await db.execute(sql`
      SELECT t.referrer_contact_id::text AS referrer,
             count(*) FILTER (WHERE t.status <> 'rejected')::int AS touched,
             count(*) FILTER (
               WHERE t.status IN ('bound', 'qualified')
             )::int AS bound,
             count(*) FILTER (WHERE t.status = 'qualified')::int AS qualified
      FROM referral_touches t
      WHERE t.referral_id = ${referralId}
        AND t.referrer_contact_id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY 1
    `)) as unknown as { rows?: DirectRow[] } | DirectRow[];
    const directRows: DirectRow[] = Array.isArray(direct)
      ? direct
      : (direct.rows ?? []);
    const byId = new Map(directRows.map((r) => [r.referrer, r]));
    for (const beneficiary of page) {
      const row = byId.get(beneficiary.contactId);
      if (!row) continue;
      beneficiary.direct = {
        touched: Number(row.touched),
        bound: Number(row.bound),
        qualified: Number(row.qualified),
      };
    }
  }

  return { beneficiaries: page, nextOffset };
}

// ---------------------------------------------------------------------------
// tree drill-in
// ---------------------------------------------------------------------------

export interface ReferralTreeNode {
  contactId: string;
  level: number;
  /** The contact one hop up - the beneficiary's own referrer at `level - 1`. */
  viaContactId: string;
  status: string;
  touchedAt: string;
  boundAt: string | null;
  qualifiedAt: string | null;
  conversions: number;
  value: CurrencyValue[];
}

export interface ReferralTreeOptions {
  db: Database;
  referralId: string;
  contactId: string;
  depth: number;
  limit: number;
}

interface TreeNodeRow {
  contact_id: string;
  level: number;
  via_contact_id: string;
  status: string;
  touched_at: string | Date;
  bound_at: string | Date | null;
  qualified_at: string | Date | null;
  currency: string | null;
  conversions: number | null;
  value: number | null;
}

/**
 * The DESCENDANTS of one referrer, to `depth`. Unlike the report this is a
 * ledger view, not a model: every non-rejected edge is walked, no window is
 * applied, and nothing is weighted. It answers "who did this person bring in,
 * and what happened to them".
 */
export async function getReferralTree(
  opts: ReferralTreeOptions,
): Promise<ReferralTreeNode[]> {
  const { db, referralId, contactId, depth, limit } = opts;

  const rows = (await db.execute(sql`
    WITH RECURSIVE
    live AS (
      SELECT t.referrer_contact_id AS referrer,
             t.referee_contact_id AS referee,
             t.status, t.touched_at, t.bound_at, t.qualified_at
      FROM referral_touches t
      WHERE t.referral_id = ${referralId}
        AND t.referee_contact_id IS NOT NULL
        AND t.status <> 'rejected'
    ),
    walk AS (
      SELECT l.referee AS contact_id, 1 AS level,
             l.referrer AS via_contact_id, l.status,
             l.touched_at, l.bound_at, l.qualified_at,
             ARRAY[l.referrer, l.referee] AS path
      FROM live l
      WHERE l.referrer = ${contactId}::uuid
      UNION ALL
      SELECT l.referee, w.level + 1, l.referrer, l.status,
             l.touched_at, l.bound_at, l.qualified_at,
             w.path || l.referee
      FROM walk w
      JOIN live l ON l.referrer = w.contact_id
      WHERE w.level < ${depth}::int
        AND NOT (l.referee = ANY(w.path))
    ),
    conv AS (
      SELECT c.contact_id AS referee,
             COALESCE(c.currency, ${NO_CURRENCY}) AS currency,
             count(*)::int AS conversions,
             COALESCE(SUM(c.value), 0)::float8 AS value
      FROM conversions c
      GROUP BY 1, 2
    ),
    -- The cap is on NODES. Applying it after the currency join would let a
    -- two-currency node consume two slots and cut its own value list short.
    nodes AS (
      SELECT * FROM walk
      ORDER BY level, touched_at
      LIMIT ${limit}::int
    )
    SELECT w.contact_id::text AS contact_id, w.level,
           w.via_contact_id::text AS via_contact_id, w.status,
           w.touched_at, w.bound_at, w.qualified_at,
           cv.currency, cv.conversions, cv.value
    FROM nodes w
    LEFT JOIN conv cv ON cv.referee = w.contact_id
    ORDER BY w.level, w.touched_at, cv.currency
  `)) as unknown as { rows?: TreeNodeRow[] } | TreeNodeRow[];

  const nodeRows: TreeNodeRow[] = Array.isArray(rows)
    ? rows
    : (rows.rows ?? []);

  const byNode = new Map<string, ReferralTreeNode>();
  for (const row of nodeRows) {
    const key = `${row.contact_id}:${row.level}:${row.via_contact_id}`;
    const node = byNode.get(key) ?? {
      contactId: row.contact_id,
      level: Number(row.level),
      viaContactId: row.via_contact_id,
      status: row.status,
      touchedAt: new Date(row.touched_at).toISOString(),
      boundAt: row.bound_at ? new Date(row.bound_at).toISOString() : null,
      qualifiedAt: row.qualified_at
        ? new Date(row.qualified_at).toISOString()
        : null,
      conversions: 0,
      value: [],
    };
    if (row.currency) {
      node.conversions += Number(row.conversions ?? 0);
      node.value.push({
        currency: row.currency,
        value: Number(row.value ?? 0),
      });
    }
    byNode.set(key, node);
  }
  return [...byNode.values()];
}
