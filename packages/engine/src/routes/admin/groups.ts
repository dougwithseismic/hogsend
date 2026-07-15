import type { Database } from "@hogsend/db";
import { contacts, groupMemberships, groups, userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import type { FxRatesToBase } from "../../lib/fx.js";
import type { Logger } from "../../lib/logger.js";
import { trustedValuedEventFilter } from "../../lib/revenue.js";

/**
 * Read-only admin surface over the sovereign group model — the endpoints the
 * Studio OBSERVE view consumes. Groups are pure DB rows (`groups` /
 * `group_memberships`), so unlike buckets there is no registry: every query hits
 * the tables directly. All dates serialize to ISO strings; the router inherits
 * the admin router's `requireAdmin` guard, so it never re-auths here.
 */

const groupSchema = z.object({
  id: z.string(),
  groupType: z.string(),
  groupKey: z.string(),
  displayName: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  memberCount: z.number(),
  // Money on this group's tagged events, GROUPED PER CURRENCY and never summed
  // across them (the revenue spine's law — a GBP deal and a USD deal don't add),
  // mirroring the contact rollup's `totals` shape. Empty when the group has no
  // valued events. See `groupRevenueTotals`.
  revenueTotals: z.array(
    z.object({ currency: z.string().nullable(), total: z.number() }),
  ),
  // The group's money CONVERTED into the operator's base currency — the
  // opt-in FX lens (docs/groups.md §Base-currency lens), a view layered on
  // top of `revenueTotals`, never a replacement for it. Null when the lens is
  // off/unavailable, or when ANY of this group's currencies lacks a rate — a
  // partial sum is a lie. 0 when the lens is on and the group has no money.
  revenueBase: z.number().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

// Non-null exactly when the base-currency lens served this response, so the
// Studio can label converted figures honestly ("≈ in USD, rates as of <date>").
const fxSchema = z.object({
  baseCurrency: z.string(),
  asOf: z.string().nullable(),
});

const memberSchema = z.object({
  contactId: z.string(),
  email: z.string().nullable(),
  externalId: z.string().nullable(),
  role: z.string().nullable(),
  joinedAt: z.string(),
});

const eventSchema = z.object({
  id: z.string(),
  event: z.string(),
  occurredAt: z.string(),
  userId: z.string(),
});

const errorSchema = z.object({ error: z.string() });

/** The columns a serialized group needs — the row may come from the query
 * builder (list/detail) or from the raw aggregate-sorted statement below. */
type GroupRowLike = Pick<
  typeof groups.$inferSelect,
  | "id"
  | "groupType"
  | "groupKey"
  | "displayName"
  | "properties"
  | "firstSeenAt"
  | "lastSeenAt"
>;

/** One currency's worth of a group's money — the displayable unit. */
interface RevenueTotal {
  currency: string | null;
  total: number;
}

/**
 * The lens's per-group converted figure: sum over the per-currency totals of
 * `total × rate(currency→base)`. Null when the lens is off (`rates` null) OR
 * any currency present lacks a rate — including the null "no currency
 * recorded" bucket — because a partial sum would LIE (it would display a
 * group as smaller than it is). Empty totals with the lens on = 0: no money
 * is zero in any currency.
 */
function revenueBaseOf(
  totals: RevenueTotal[],
  rates: Record<string, number> | null,
): number | null {
  if (!rates) return null;
  let sum = 0;
  for (const t of totals) {
    const rate = t.currency === null ? undefined : rates[t.currency];
    if (rate === undefined) return null;
    sum += t.total * rate;
  }
  return sum;
}

function serializeGroup(
  row: GroupRowLike,
  memberCount: number,
  revenueTotals: RevenueTotal[],
  rates: Record<string, number> | null,
) {
  return {
    id: row.id,
    groupType: row.groupType,
    groupKey: row.groupKey,
    displayName: row.displayName,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    memberCount,
    revenueTotals,
    revenueBase: revenueBaseOf(revenueTotals, rates),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function serializeMember(row: {
  contactId: string;
  email: string | null;
  externalId: string | null;
  role: string | null;
  joinedAt: Date;
}) {
  return {
    contactId: row.contactId,
    email: row.email,
    externalId: row.externalId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

function serializeEvent(row: {
  id: string;
  event: string;
  occurredAt: Date;
  userId: string;
}) {
  return {
    id: row.id,
    event: row.event,
    occurredAt: row.occurredAt.toISOString(),
    userId: row.userId,
  };
}

// --- Revenue rollup ---

/**
 * Money belongs to a group when a valued event's `groups` association map
 * CONTAINS that group. Two shapes serve two different needs:
 *
 *  - `revenueForPage` — what is DISPLAYED. Grouped PER CURRENCY and never summed
 *    across currencies (`lib/revenue.ts`'s law: a GBP deal and a USD deal don't
 *    add), exactly like the contact rollup's `totals`.
 *  - `groupRevenueRanking` — what ORDERS `sort=revenue`. A single cross-currency
 *    scalar, an ordering HEURISTIC only: exact for a single-currency deployment
 *    (the common case), an approximation for a mixed-currency one — the same
 *    trade the contacts list already makes with its `minRevenue` threshold. It
 *    ranks; it never reaches the response.
 *
 * Both share `trustedValuedEventFilter()` — the gate the contact rollup uses —
 * so a group's revenue and its members' revenue can never disagree: no
 * re-counting the CRM machinery events that carry one deal's value on every
 * stage change, and no browser-minted (`inapp`) values.
 */

/**
 * Escape LIKE/ILIKE metacharacters so a search string can't widen its own match
 * (`promo_50` must match `promo_50`, not `promoX50`; a trailing `\` must not
 * break the pattern). Same idiom as the event-name search in `lib/event-names`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * "This event is tagged with this group" — jsonb containment against the
 * association map, the shape the partial GIN index is built for.
 */
function groupContainment(groupType: string, groupKey: string): SQL {
  return sql`${userEvents.groups} @> ${JSON.stringify({
    [groupType]: groupKey,
  })}::jsonb`;
}

/**
 * `(groupType, groupKey)` as a Map key. The NUL separator cannot occur inside
 * a Postgres text value, so no two distinct natural keys can collide.
 */
function naturalKey(groupType: string, groupKey: string): string {
  return `${groupType}\u0000${groupKey}`;
}

/**
 * Per-currency revenue for JUST the groups on a page (≤ `limit` of them), keyed
 * by natural key.
 *
 * The rows are selected by an OR of jsonb CONTAINMENTS, which the partial GIN
 * (`user_events_valued_groups_idx`, over the valued+grouped slice) serves — so
 * the displayed money never costs a scan of the event spine. The lateral then
 * expands only those matched rows, and the `(kv.key, kv.value) IN (…)` residual
 * drops the OTHER groups an event may also be tagged with (an event tagged both
 * `company` and `team` yields a kv row for each; only the page's pairs count).
 */
async function revenueForPage(
  db: Database,
  rows: readonly GroupRowLike[],
): Promise<Map<string, RevenueTotal[]>> {
  const totals = new Map<string, RevenueTotal[]>();
  if (rows.length === 0) return totals;

  const contains = sql.join(
    rows.map((r) => groupContainment(r.groupType, r.groupKey)),
    sql` or `,
  );
  const pairs = sql.join(
    rows.map((r) => sql`(${r.groupType}, ${r.groupKey})`),
    sql`, `,
  );

  const revenueRows = await db.execute<{
    group_type: string;
    group_key: string;
    currency: string | null;
    total: string;
  }>(sql`
    select kv.key as group_type,
           kv.value as group_key,
           ${userEvents.currency} as currency,
           sum(${userEvents.value})::float8 as total
    from ${userEvents}, lateral jsonb_each_text(${userEvents.groups}) kv
    where ${trustedValuedEventFilter()}
      and (${contains})
      and (kv.key, kv.value) in (${pairs})
    group by kv.key, kv.value, ${userEvents.currency}
  `);

  for (const row of revenueRows) {
    const key = naturalKey(row.group_type, row.group_key);
    const bucket = totals.get(key) ?? [];
    bucket.push({ currency: row.currency, total: Number(row.total) });
    totals.set(key, bucket);
  }
  // Biggest first within a group, mirroring `getContactRevenue`'s totals.
  for (const bucket of totals.values()) {
    bucket.sort((a, b) => b.total - a.total);
  }
  return totals;
}

/**
 * The cross-currency RANKING scalar behind `sort=revenue` — every group in one
 * grouped pass, because the order has to be decided across ALL groups before the
 * page is cut, so it cannot be page-scoped (and therefore cannot ride the GIN).
 * That full pass covers only the valued+grouped slice, which is small by design
 * and kept tight by the partial index.
 */
function groupRevenueRanking(): SQL {
  return sql`
    select kv.key as group_type,
           kv.value as group_key,
           sum(${userEvents.value})::float8 as revenue
    from ${userEvents}, lateral jsonb_each_text(${userEvents.groups}) kv
    where ${trustedValuedEventFilter()}
    group by kv.key, kv.value
  `;
}

/**
 * The base-CONVERTED twin of {@link groupRevenueRanking}, used for
 * `sort=revenue` when the FX lens is active AND every currency in play has a
 * rate: the resolved quote→base map joins in as a VALUES list, so each
 * event's value converts in SQL (`value × rate`) and the ranking scalar
 * becomes real base-currency money instead of the cross-currency heuristic.
 * The comma-join on currency is safe precisely because the caller proved
 * convertibility first ({@link unconvertibleCurrencies}) — nothing can drop.
 */
function groupRevenueRankingInBase(rates: Record<string, number>): SQL {
  const values = sql.join(
    Object.entries(rates).map(
      ([currency, rate]) => sql`(${currency}::text, ${rate}::float8)`,
    ),
    sql`, `,
  );
  return sql`
    select kv.key as group_type,
           kv.value as group_key,
           sum(${userEvents.value} * fxr.rate)::float8 as revenue
    from ${userEvents},
         lateral jsonb_each_text(${userEvents.groups}) kv,
         (values ${values}) as fxr(currency, rate)
    where ${trustedValuedEventFilter()}
      and ${userEvents.currency} = fxr.currency
    group by kv.key, kv.value
  `;
}

/**
 * The convertibility PROBE behind the ranking's wholesale-fallback rule: the
 * distinct currencies on trusted valued events tagged with a group matching
 * this request's filter, minus the ones the rate sheet covers. Scoped to the
 * FILTERED groups (not the whole valued+grouped slice) because only their
 * revenues decide this page's order — an exotic currency on some unrelated
 * group must not knock a clean single-currency view off the converted
 * ranking. A null currency (a valued event ingested without one) can never
 * have a rate and reports as "(none)".
 */
async function unconvertibleCurrencies(
  db: Database,
  where: SQL,
  rates: Record<string, number>,
): Promise<string[]> {
  const rows = await db.execute<{ currency: string | null }>(sql`
    select distinct ${userEvents.currency} as currency
    from ${userEvents}, lateral jsonb_each_text(${userEvents.groups}) kv
    inner join ${groups}
      on ${groups.groupType} = kv.key
     and ${groups.groupKey} = kv.value
    where ${trustedValuedEventFilter()}
      and (${where})
  `);
  return rows
    .map((r) => r.currency)
    .filter((c) => c === null || rates[c] === undefined)
    .map((c) => c ?? "(none)");
}

// --- List paths (column-sorted vs aggregate-sorted) ---

interface ListOpts {
  where: SQL;
  sort: "lastSeen" | "members" | "revenue" | "name";
  order: "asc" | "desc";
  limit: number;
  offset: number;
  /**
   * The resolved quote→base rate map when the FX lens is ACTIVE (base
   * currency set AND the provider served rates), else null. Drives the
   * per-group `revenueBase` figure on both list paths and, on
   * `sort=revenue`, the base-converted ranking.
   */
  rates: Record<string, number> | null;
  logger: Logger;
}

/**
 * One grouped count over the page's group ids — mirrors how buckets maps its
 * per-bucket status counts back onto the listed rows. Joined to LIVE contacts
 * so the count matches exactly the set the members endpoint lists (a membership
 * whose contact is soft-deleted must not over-count).
 */
async function memberCountsForPage(
  db: Database,
  groupIds: string[],
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ groupId: groupMemberships.groupId, count: count() })
    .from(groupMemberships)
    .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
    .where(
      and(
        inArray(groupMemberships.groupId, groupIds),
        isNull(contacts.deletedAt),
      ),
    )
    .groupBy(groupMemberships.groupId);
  return new Map(rows.map((r) => [r.groupId, r.count]));
}

/**
 * Sorts that live on a `groups` column (`lastSeen`, `name`): the page is cut
 * from `groups` alone, then both aggregates are resolved for JUST that page.
 */
async function listByColumn(db: Database, opts: ListOpts) {
  const direction = opts.order === "asc" ? asc : desc;
  const sortCol =
    opts.sort === "name"
      ? sql`coalesce(${groups.displayName}, ${groups.groupKey})`
      : groups.lastSeenAt;

  const rows = await db
    .select()
    .from(groups)
    .where(opts.where)
    // `id` breaks ties so paging over equal sort keys stays stable.
    .orderBy(direction(sortCol), asc(groups.id))
    .limit(opts.limit)
    .offset(opts.offset);

  const [countMap, revenueMap] = await Promise.all([
    memberCountsForPage(
      db,
      rows.map((r) => r.id),
    ),
    revenueForPage(db, rows),
  ]);

  return rows.map((r) =>
    serializeGroup(
      r,
      countMap.get(r.id) ?? 0,
      revenueMap.get(naturalKey(r.groupType, r.groupKey)) ?? [],
      opts.rates,
    ),
  );
}

/**
 * Sorts driven by an aggregate (`members`, `revenue`): the order has to be
 * decided across ALL matching groups BEFORE the page is cut, so both aggregates
 * become grouped CTEs joined to the filtered groups and the ORDER BY reads one
 * of them. Sorting the rows a `lastSeen` page happened to contain would rank a
 * page-local lie. Each aggregate is still computed exactly once — no per-row
 * queries.
 *
 * `revenue` here is the cross-currency RANKING scalar (see the rollup note
 * above); the money the page DISPLAYS is re-read per currency by
 * `revenueForPage`, so a mixed-currency deployment gets an approximate order but
 * never an invented number.
 *
 * With the FX lens active, `revenue` upgrades to the base-CONVERTED sum — but
 * only WHOLESALE: if any currency on the filtered groups' events lacks a
 * rate, the whole request falls back to the heuristic scalar (warned once).
 * Excluding the unconvertible rows would zero-out a real account; converting
 * only some of a group's money would rank a partial sum. Approximate-but-
 * honest beats precise-but-wrong.
 *
 * The statement ranks + pages the IDS; the group rows themselves are hydrated
 * through the query builder, which parses the column types — drizzle's raw
 * `execute` hands back every column as text.
 */
async function listByAggregate(db: Database, opts: ListOpts) {
  const direction = opts.order === "asc" ? sql`asc` : sql`desc`;
  const sortExpr =
    opts.sort === "members"
      ? sql`coalesce(mc.member_count, 0)`
      : sql`coalesce(gr.revenue, 0)`;

  let revenueCte = groupRevenueRanking();
  if (opts.sort === "revenue" && opts.rates) {
    const missing = await unconvertibleCurrencies(db, opts.where, opts.rates);
    if (missing.length === 0) {
      revenueCte = groupRevenueRankingInBase(opts.rates);
    } else {
      opts.logger.warn(
        `groups sort=revenue: no base-currency rate for ${missing.join(", ")} — this request ranked by the cross-currency heuristic instead (a partial conversion would misrank real money). Add the missing rate(s) to restore base-currency ranking.`,
      );
    }
  }

  const ranked = Array.from(
    await db.execute<{
      id: string;
      member_count: string;
    }>(sql`
      with member_counts as (
        select ${groupMemberships.groupId} as group_id,
               count(*)::int as member_count
        from ${groupMemberships}
        inner join ${contacts}
          on ${contacts.id} = ${groupMemberships.contactId}
        where ${contacts.deletedAt} is null
        group by ${groupMemberships.groupId}
      ),
      group_revenue as (${revenueCte})
      select ${groups.id} as id,
             coalesce(mc.member_count, 0) as member_count
      from ${groups}
      left join member_counts mc on mc.group_id = ${groups.id}
      left join group_revenue gr
        on gr.group_type = ${groups.groupType}
       and gr.group_key = ${groups.groupKey}
      where ${opts.where}
      -- id breaks ties so paging over equal aggregates stays stable.
      order by ${sortExpr} ${direction}, ${groups.id} asc
      limit ${opts.limit} offset ${opts.offset}
    `),
  );
  if (ranked.length === 0) return [];

  const rows = await db
    .select()
    .from(groups)
    .where(
      inArray(
        groups.id,
        ranked.map((r) => r.id),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const revenueMap = await revenueForPage(db, rows);

  // Re-imposes the ranked order the hydration lookup doesn't preserve.
  return ranked.flatMap((r) => {
    const row = byId.get(r.id);
    if (!row) return [];
    return [
      serializeGroup(
        row,
        Number(r.member_count),
        revenueMap.get(naturalKey(row.groupType, row.groupKey)) ?? [],
        opts.rates,
      ),
    ];
  });
}

// --- Route definitions ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Groups"],
  summary: "List groups",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      groupType: z.string().optional(),
      // Case-insensitive substring over the group's identity: its key or its
      // display name. LIKE metacharacters are escaped, so it matches literally.
      search: z.string().optional(),
      // `revenue` ranks on the CROSS-CURRENCY sum — an ordering heuristic
      // (exact for a single-currency deployment, approximate for a mixed one),
      // never a displayed figure: the money itself comes back per currency in
      // `revenueTotals`. Same trade as the contacts list's `minRevenue`.
      // With the FX lens active (BASE_CURRENCY + rates) the ranking upgrades
      // to the base-converted sum — falling back WHOLESALE to the heuristic
      // when any currency in play lacks a rate.
      sort: z
        .enum(["lastSeen", "members", "revenue", "name"])
        .default("lastSeen"),
      order: z.enum(["desc", "asc"]).default("desc"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            groups: z.array(groupSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
            fx: fxSchema.nullable(),
          }),
        },
      },
      description: "Paginated group list, newest-seen first by default",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}",
  tags: ["Admin — Groups"],
  summary: "Get group detail",
  request: {
    params: z.object({ groupType: z.string(), groupKey: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            group: groupSchema.extend({
              recentMembers: z.array(memberSchema),
              recentEvents: z.array(eventSchema),
            }),
            fx: fxSchema.nullable(),
          }),
        },
      },
      description: "Group detail with recent members and recent tagged events",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Group not found",
    },
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}/members",
  tags: ["Admin — Groups"],
  summary: "List group members",
  request: {
    params: z.object({ groupType: z.string(), groupKey: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(memberSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated group members, newest-joined first",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Group not found",
    },
  },
});

// --- Handlers ---

/** The `fx` response block: non-null exactly when the lens served rates. */
function fxResponseOf(sheet: FxRatesToBase | null) {
  return sheet ? { baseCurrency: sheet.baseCurrency, asOf: sheet.asOf } : null;
}

export const groupsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const container = c.get("container");
    const { db, logger } = container;
    const { limit, offset, groupType, search, sort, order } =
      c.req.valid("query");

    // Resolve the FX lens ONCE per request (fail-soft: off/unavailable ⇒
    // null) so every row on the page converts through the same sheet.
    const fxSheet = await container.fx.getRatesToBase();
    const rates = fxSheet?.rates ?? null;

    // Every filter lives on `groups`, so one predicate serves the page, the
    // aggregate-sorted statement, and `total` alike.
    const where: SQL =
      and(
        isNull(groups.deletedAt),
        ...(groupType ? [eq(groups.groupType, groupType)] : []),
        ...(search
          ? [
              or(
                ilike(groups.groupKey, `%${escapeLike(search)}%`),
                ilike(groups.displayName, `%${escapeLike(search)}%`),
              ),
            ]
          : []),
      ) ?? sql`true`;

    const totalPromise = db
      .select({ count: count() })
      .from(groups)
      .where(where);

    const listOpts = { where, sort, order, limit, offset, rates, logger };
    const rowsPromise =
      sort === "members" || sort === "revenue"
        ? listByAggregate(db, listOpts)
        : listByColumn(db, listOpts);

    const [rows, totalRows] = await Promise.all([rowsPromise, totalPromise]);

    return c.json(
      {
        groups: rows,
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
        fx: fxResponseOf(fxSheet),
      },
      200,
    );
  })
  .openapi(listMembersRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");

    const groupRows = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.groupType, groupType),
          eq(groups.groupKey, groupKey),
          isNull(groups.deletedAt),
        ),
      )
      .limit(1);
    const group = groupRows[0];
    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    // Join to LIVE contacts so a soft-deleted contact never surfaces; the total
    // counts the same joined set the page is drawn from.
    const memberWhere = and(
      eq(groupMemberships.groupId, group.id),
      isNull(contacts.deletedAt),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          contactId: groupMemberships.contactId,
          email: contacts.email,
          externalId: contacts.externalId,
          role: groupMemberships.role,
          joinedAt: groupMemberships.joinedAt,
        })
        .from(groupMemberships)
        .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
        .where(memberWhere)
        .orderBy(desc(groupMemberships.joinedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(groupMemberships)
        .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
        .where(memberWhere),
    ]);

    return c.json(
      {
        members: rows.map(serializeMember),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const container = c.get("container");
    const { db } = container;
    const { groupType, groupKey } = c.req.valid("param");

    const groupRows = await db
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.groupType, groupType),
          eq(groups.groupKey, groupKey),
          isNull(groups.deletedAt),
        ),
      )
      .limit(1);
    const group = groupRows[0];
    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    // Containment against this ONE group's natural key — the single-group twin
    // of the list's lateral rollup, no expansion needed, and GIN-served.
    const taggedEvents = groupContainment(groupType, groupKey);

    const [memberCountRows, revenueRows, recentMemberRows, recentEventRows] =
      await Promise.all([
        // Same LIVE-contact join as recentMembers below (and as the members
        // endpoint) so memberCount never disagrees with the list it heads.
        db
          .select({ count: count() })
          .from(groupMemberships)
          .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
          .where(
            and(
              eq(groupMemberships.groupId, group.id),
              isNull(contacts.deletedAt),
            ),
          ),
        // Per currency, never summed across them — the same law (and the same
        // trust gate) as the list rollup and `getContactRevenue`.
        db
          .select({
            currency: userEvents.currency,
            total: sql<number>`sum(${userEvents.value})::float8`,
          })
          .from(userEvents)
          .where(and(trustedValuedEventFilter(), taggedEvents))
          .groupBy(userEvents.currency),
        db
          .select({
            contactId: groupMemberships.contactId,
            email: contacts.email,
            externalId: contacts.externalId,
            role: groupMemberships.role,
            joinedAt: groupMemberships.joinedAt,
          })
          .from(groupMemberships)
          .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
          .where(
            and(
              eq(groupMemberships.groupId, group.id),
              isNull(contacts.deletedAt),
            ),
          )
          .orderBy(desc(groupMemberships.joinedAt))
          .limit(10),
        // Events carry a `groups` association map (groupType → groupKey); the
        // jsonb containment operator selects those tagged with this group.
        db
          .select({
            id: userEvents.id,
            event: userEvents.event,
            occurredAt: userEvents.occurredAt,
            userId: userEvents.userId,
          })
          .from(userEvents)
          .where(taggedEvents)
          .orderBy(desc(userEvents.occurredAt))
          .limit(20),
      ]);

    const memberCount = memberCountRows[0]?.count ?? 0;
    const revenueTotals: RevenueTotal[] = revenueRows
      .map((r) => ({ currency: r.currency, total: Number(r.total) }))
      .sort((a, b) => b.total - a.total);

    // Same lens as the list: one sheet per request, fail-soft to null.
    const fxSheet = await container.fx.getRatesToBase();

    return c.json(
      {
        group: {
          ...serializeGroup(
            group,
            memberCount,
            revenueTotals,
            fxSheet?.rates ?? null,
          ),
          recentMembers: recentMemberRows.map(serializeMember),
          recentEvents: recentEventRows.map(serializeEvent),
        },
        fx: fxResponseOf(fxSheet),
      },
      200,
    );
  });
