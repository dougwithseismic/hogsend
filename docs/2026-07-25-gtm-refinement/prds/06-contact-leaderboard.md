# PRD 06 — Contact leaderboard (rank by property)

**Depends on:** none (independent) · **Status:** `[ ]`

## Goal

Answer "who do I call today". Today `GET /v1/admin/contacts` accepts only
`limit/offset/search/minRevenue/dealStage` and hardcodes `ORDER BY lastSeenAt DESC`, and
`contacts.properties` has **zero index coverage**. Without this you can refine and score a contact
and still not list your top 50 — which makes a bucket a boolean and never a signal.

## Locked decisions

- Add a GIN index `ON contacts USING gin (properties jsonb_path_ops)`. Precedent:
  `user_events_valued_groups_idx` in `0057_productive_shen.sql`, the only GIN in the migration set.
- **The numeric expression MUST be type-guarded.** `contacts.properties` is untyped jsonb and any
  caller may write a string at any key (`routes/events/index.ts` accepts
  `z.record(z.string(), z.unknown())`), so a bare `(properties->>key)::numeric` raises Postgres
  `22P02` and 500s the whole request the first time one contact holds `"n/a"` at the sort key.
  Verified empirically. Use, for **both** the sort key and the `propertyGte` filter:

  ```ts
  sql`CASE WHEN jsonb_typeof(${contacts.properties} -> ${key}) = 'number'
           THEN (${contacts.properties} ->> ${key})::numeric END`
  ```

  This also matches DECISIONS §3.4 — only real JSON numbers count. Precedent for `jsonb_typeof` in
  this repo: `packages/engine/src/journeys/journey-context.ts:1140`.
- The property key is **bound as a parameter**, never interpolated (see the `${key}` placeholders
  above), *and* validated against `/^[A-Za-z0-9_.-]{1,64}$/` with a 400 on failure. Both layers, not one.
- **Be honest in the docs: GIN accelerates containment filters, not ordering.** A deployment sorting
  hot on one key adds its own expression index — and it must be the **same guarded expression**, not
  a bare cast and not a partial index:

  ```sql
  CREATE INDEX contacts_gtm_score_idx
    ON contacts ((CASE WHEN jsonb_typeof(properties->'gtmScore') = 'number'
                       THEN (properties->>'gtmScore')::numeric END) DESC NULLS LAST);
  ```

  Verified on PG18: this builds, tolerates a later non-numeric write at that key, and is actually
  chosen by the planner for the guarded `ORDER BY`. A bare-cast index instead **errors during index
  maintenance on any subsequent non-numeric write** — a write-path outage. A partial index
  (`WHERE jsonb_typeof(...) = 'number'`) is never chosen by this query because the query carries no
  matching predicate, so it would ship a documented acceleration that does not happen. This exact
  one-liner is what PRD 07 T7.3 puts in the docs.
- An unindexed sort is a sequential scan — acceptable at GTM volume (thousands of contacts), not at
  product-analytics volume. Do not claim otherwise in a comment or doc.
- Numeric ordering uses `NULLS LAST` in both directions, so unscored contacts never top the list.

## Query surface

| Param | Type | Default |
|---|---|---|
| `orderBy` | `"lastSeenAt" \| "firstSeenAt" \| "property"` | `"lastSeenAt"` |
| `orderProperty` | string, validated | — (required when `orderBy=property`) |
| `orderDir` | `"asc" \| "desc"` | `"desc"` |
| `propertyKey` | string, validated | — |
| `propertyGte` | number | — |

`propertyKey` + `propertyGte` filter; `orderBy=property` + `orderProperty` sort. They are independent
and composable.

## Acceptance criteria (EARS)

1. WHEN `orderBy=property&orderProperty=gtmScore&orderDir=desc` is requested the system SHALL return
   contacts ordered by the numeric value of that property, highest first, with unscored contacts last.
2. WHEN `orderBy=property` is requested without `orderProperty` the system SHALL respond 400.
3. WHEN `orderProperty` or `propertyKey` contains a character outside `[A-Za-z0-9_.-]` or exceeds 64
   characters the system SHALL respond 400 and SHALL NOT execute a query.
4. WHEN a contact's value at the ordering key is non-numeric the system SHALL sort it as null rather
   than erroring.
5. WHEN `propertyKey=gtmScore&propertyGte=20` is requested the system SHALL return only contacts whose
   numeric value at that key is ≥ 20.
6. WHEN no ordering params are supplied the system SHALL behave exactly as before
   (`ORDER BY lastSeenAt DESC`) — existing callers must not change behaviour.
7. WHEN a property key containing a SQL metacharacter is submitted the system SHALL reject it at
   validation, and the underlying query SHALL in any case pass the key as a bound parameter.
8. WHEN a contact holds a non-numeric value at `propertyKey` the `propertyGte` filter SHALL exclude
   that contact and SHALL NOT error. (AC 4 covers the ordering path; this covers the filter path.)
9. WHEN the documented expression index from the locked decisions exists and a contact subsequently
   receives a non-numeric value at the indexed key, the ingest write SHALL still succeed. Test this
   by creating the index, then writing `{"gtmScore": "n/a"}` via the normal ingest path.

## Tasks

### T6.1 — GIN index migration
_Boundary:_ `packages/db` · _Depends:_ —

Add the index to the `contacts` schema declaration; generate with `cd packages/db && pnpm db:generate`.
Commit the generated SQL.

### T6.2 — Admin route ordering + filtering
_Boundary:_ `packages/engine` · _Depends:_ T6.1

Extend the query schema and the query builder in `packages/engine/src/routes/admin/contacts.ts`.
Keep the existing `search`/`minRevenue`/`dealStage` behaviour intact.

_Test:_ all nine acceptance criteria, including a regression test for AC 6. AC 4, 8 and 9 are the
type-guard tests — seed a contact with a string at the sort/filter key before asserting.

### T6.3 — Studio sortable column
_Boundary:_ `packages/studio` · _Depends:_ T6.2

One sortable column on `views/contacts-view.tsx` bound to a configurable property key, using the new
params. Match the existing table's visual language — do not introduce new styling primitives.

_Verify:_ run the real app and screenshot the sorted column. No mockups.

## Seams

None.

## Done when

Nine acceptance criteria pass, gates green, the migration is committed, and a screenshot shows the
Studio column sorting real data.

## Implementation Notes

_(filled in during build)_
