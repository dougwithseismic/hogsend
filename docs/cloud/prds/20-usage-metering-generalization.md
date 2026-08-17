# PRD 20 — Usage metering + price-gating generalization (metric registry)

- **Status:** proposed (not started)
- **Owner:** platform
- **Boundary:** `apps/cloud` only. No `packages/engine` change (the ingest-suspend
  flag from PRD 06 is reused as-is).
- **Depends:** PRD 06 (billing-metering — the model this PRD generalizes), PRD 09
  (Hogsend Email relay meter — the second, increment-sourced meter that forced the
  duality this PRD makes first-class).
- **Supersedes at BUILD time:** the hand-maintained column-per-feature meter in
  `src/db/schema/usage-counters.ts` and its five read/write sites.

---

## 1. Context — what exists, and why it does not scale

Cloud today meters exactly three numbers, each as its own hardcoded `bigint`
column on one wide table, `usage_counters`
(`src/db/schema/usage-counters.ts:26-51`):

| Column | Written by | Write mode | Source | Billed? |
|---|---|---|---|---|
| `events_count` | nightly sweep | **absolute set** | tenant DB `user_events` | included-limit gate only |
| `emails_count` | nightly sweep | **absolute set** | tenant DB `email_sends` | included-limit gate only |
| `relay_emails_count` | relay send path | **increment** | our SES relay | included-limit gate **and** Stripe overage |

The two write modes are not a detail — they are the load-bearing invariant the
schema documents by hand today. `usage-counters.ts:32-48` spends sixteen lines
explaining that `relay_emails_count` MUST be its own column because
`emails_count` is "written ABSOLUTELY by the nightly sweep… An increment into the
same column would be overwritten every night at 03:00, and a meter a sweep can
clobber is not a meter." That comment is a design rule with no code to enforce
it: nothing stops a future engineer pointing an increment at an absolute column.

Adding one new metered thing (say SMS segments, or connector actions) today costs
a Drizzle migration **plus five hardcoded edits**, and every one of them has to
independently re-derive the absolute-vs-increment question:

1. **Schema** — add a column to `src/db/schema/usage-counters.ts` (mirror
   `relayEmailsCount`, lines 49-51), generate + run a migration.
2. **Writer** — either the absolute path in
   `src/services/usage.ts:134-156` (`upsertUsageCounter`, the sweep's sink) or the
   increment path in `src/services/email-usage.ts:53-96` (`recordRelayEmails`).
   These are two different functions with two different upsert `set` clauses, and
   the new metric has to pick the right one by hand.
3. **Enforcement sum** — `src/metering/enforcement.ts:129-148`
   (`organizationTotals`) hardcodes `sum(usageCounters.eventsCount)` +
   `sum(usageCounters.emailsCount)` and compares them against two hardcoded
   `PlanLimits` fields (`enforcement.ts:204-206`).
4. **Usage view read** — `src/services/usage.ts:226-247` (`readUsageView`) selects
   the columns literally and folds them per-environment (lines 252-274), then
   compares against `limits.eventsPerMonth` / `limits.emailsPerMonth`
   (`usage.ts:286-287`). Onboarding does its own literal read at
   `src/lib/onboarding.ts:104-105`.
5. **Plan limits** — `src/services/plan-limits.ts:14-87` carries a fixed
   `PlanLimits` interface (`eventsPerMonth`, `emailsPerMonth`, `emailOverage`,
   `emailHardCap`) and a `PLAN_LIMITS` table restated per tier. A new meter means
   new interface fields and a new value in all three tier literals.

On the Stripe side, the meter vocabulary is a single string literal:
`export type UsageMeter = "email_overage"` (`src/billing/types.ts:106`), consumed
by `src/metering/overage.ts:56` and mapped to a Stripe meter event name in
`src/billing/stripe.ts:88,287-317`. A second billable meter cannot exist without
widening that literal and threading it through `reportUsage`.

**Confirmed unmetered in cloud today** (grep over `apps/cloud/src`, tests
excluded): SMS, connectors (Discord/Telegram), attribution, funnels, groups, MCP,
and seats. None of them appear in any meter, `usage_counters` column, `PlanLimits`
field, or `UsageMeter` value. They are shipped engine features with zero cloud
price-gating. That is the gap this PRD closes structurally rather than by adding a
third, fourth, and fifth column.

### Non-goal, stated up front

`email_daily_sends` (`src/services/email-usage.ts:82-95`,
`readRelaySendingWindow`) stays OUT of this model. It is an **abuse counter** for
the free tier's daily cap and the "established sender" heuristic, not a billing
meter — it is written per-UTC-day, never summed into an invoice, and never
reported to Stripe. Folding it into the billing metric registry would conflate
fraud control with revenue and invite exactly the "cap the meter disagrees with"
problem `email-usage.ts:78-81` warns about. It keeps its own table.

---

## 2. Decisions

### D1 — Rows, not columns. `usage_metrics` replaces the wide table.

One narrow table keyed by metric id. Adding a metric becomes a registry entry and
zero DDL.

```
usage_metrics(
  id, organization_id, environment_id,
  period,          -- 'YYYY-MM' (UTC), same key space as usage_counters.month
  metric,          -- MetricKey, e.g. 'events' | 'emails' | 'relay_emails' | 'sms_segments'
  value bigint not null default 0,
  created_at, updated_at,
  unique (environment_id, period, metric)   -- the upsert arbiter AND read path
)
```

The unique index is `(environment_id, period, metric)` — the exact analogue of
today's `(environment_id, month)` (`usage-counters.ts:56-59`), extended by the one
new dimension. The org-rollup index becomes
`(organization_id, period, metric)`.

### D2 — A **code-side metric registry** carries the absolute-vs-increment rule.

The duality that `usage-counters.ts` documents in prose becomes a typed field.
Each metric declares its `source`, and `source` alone decides how the value is
written — so the sweep can never clobber a relay increment, because the writer is
selected by the metric's declared source, not by which function an engineer
happened to call.

```ts
// src/metering/metrics.ts  (new — the single source of truth)

export type MetricSource = "tenant_db" | "relay";
//  tenant_db → periodic ABSOLUTE count read from the tenant's own Postgres
//              by the nightly sweep. Written with SET.
//  relay     → INCREMENT emitted in-band by a control-plane send path
//              (the SES relay) as each unit is accepted. Written with += .

export interface MetricDef {
  /** Stable column-space id; the `metric` value stored in the row. */
  key: MetricKey;
  /** What a customer reads on the Usage page. */
  label: string;
  source: MetricSource;
  /**
   * tenant_db metrics only: the read the sweep runs against the tenant DB.
   * Mirrors the two SELECTs in metering/tenant-usage.ts today.
   */
  tenantQuery?: (w: { since: Date; until: Date }) => TenantCountQuery;
  /**
   * The billable meter this metric feeds, if any. Absent → included-limit
   * gating only (never reported to the billing provider).
   */
  billMeter?: UsageMeter;
}

export type MetricKey =
  | "events"
  | "emails"
  | "relay_emails"
  | "sms_segments";      // proof metric, Phase 3

export const METRICS: Record<MetricKey, MetricDef> = {
  events:       { key: "events",       label: "Events",        source: "tenant_db", tenantQuery: countUserEvents },
  emails:       { key: "emails",       label: "Emails sent",   source: "tenant_db", tenantQuery: countEmailSends },
  relay_emails: { key: "relay_emails", label: "Hogsend Email", source: "relay",     billMeter: "relay_email_overage" },
  // sms_segments added in Phase 3 — see §7.
};
```

Two guarded writers, and only two, keyed on `source`:

```ts
// ABSOLUTE — for MetricSource "tenant_db". The nightly sweep's sink.
// Refuses at runtime if handed a "relay" metric (belt to the type-level braces).
setMetric(db, { environmentId, organizationId, period, metric, value })

// INCREMENT — for MetricSource "relay". The in-band send path.
// Refuses at runtime if handed a "tenant_db" metric.
addMetric(db, { environmentId, organizationId, period, metric, delta })
```

`setMetric` asserts `METRICS[metric].source === "tenant_db"`; `addMetric` asserts
`=== "relay"`. The clobber the wide-table comment feared is now a thrown error in
dev, not a silent nightly overwrite in prod. `setMetric` uses
`onConflictDoUpdate … set: { value }` (absolute); `addMetric` uses
`set: { value: sql\`value + \${delta}\` }` (the exact pattern at
`email-usage.ts:73`). Both target the `(environment_id, period, metric)` index.

### D3 — Every existing read-site reads THROUGH the registry.

- `organizationTotals` (`enforcement.ts:129-148`) becomes a grouped
  `sum(value) … group by metric` over the org's window, returning
  `Record<MetricKey, number>` instead of `{ events, emails }`.
- `readUsageView` (`usage.ts:209-293`) returns a per-metric map per environment
  and a per-metric total, and computes `over` per metric against the plan (D4).
- Onboarding (`onboarding.ts:104-105`) reads `events` and `emails` by key from the
  same helper.
- The relay gate (`email-usage.ts` `createEmailAllowanceGate`) reads
  `relay_emails` by key; `recordSent` calls `addMetric("relay_emails", …)`.

### D4 — Flatten `PlanLimits` into limits-map + features-map.

```ts
// src/services/plan-limits.ts  (reshaped)

export interface MetricLimit {
  included: number;       // in-allowance ceiling for the period
  overage: boolean;       // do sends above `included` bill, or hard-stop?
  hardCap: number;        // absolute ceiling; sending/ingest stops here regardless
}

export interface PlanModel {
  environments: number;                          // stays; read off PLAN_ENVIRONMENT_LIMITS
  limits: Partial<Record<MetricKey, MetricLimit>>;
  features: Record<FeatureKey, boolean>;
}
```

A metric a plan does not cap simply omits the entry (no synthetic `Infinity`). The
current four scalar fields map exactly:

- `eventsPerMonth`      → `limits.events.included`
- `emailsPerMonth`      → `limits.relay_emails.included` (relay is the billed one)
- `emailOverage`        → `limits.relay_emails.overage`
- `emailHardCap`        → `limits.relay_emails.hardCap`

`tenant_db` "emails" (the tenant's own Resend/Postmark sends counted from
`email_sends`) keeps an included-only limit and **no** `billMeter` — billing
Hogsend Email overage off that number would "charge them for mail we never sent"
(`usage-counters.ts:41-45`). That distinction, currently implicit in there being
two columns, becomes explicit: `emails` has no `billMeter`, `relay_emails` does.

### D5 — Three gating FAMILIES. Most "features" are ENTITLEMENTS, not meters.

A metric earns a row in `usage_metrics` only if it is a *counted quantity a plan
caps*. Everything else is a boolean the plan either grants or does not. The three
families:

| Family | Mechanism | Where enforced | Examples |
|---|---|---|---|
| **A. Relay-mediated, in-band** | pre-send `canSend` gate + post-send `addMetric`; source `relay` | `email-allowance.ts` seam, per request | Hogsend Email (`relay_emails`); future: relayed SMS segments if we ever host an SMS relay |
| **B. Tenant-DB, post-hoc / coarse-suspend** | nightly sweep `setMetric` (absolute) → `reconcileOrganization` flips `HOGSEND_INGEST_SUSPENDED` | `enforcement.ts`, 03:00 sweep + on plan change | `events`, tenant-own `emails`; future: attribution rows, funnel evaluations, group count — anything countable from the tenant DB after the fact |
| **C. Boolean entitlements** | a `features` flag checked at the surface that offers the capability | provisioning / onboarding / dashboard / substrate `setEnv` | MCP access, custom tracking domain, dedicated infra, which connector *types* are allowed, region choice, SSO |

The opinion, stated plainly: **MCP, custom domain, dedicated infrastructure,
connector types, and region are entitlements, not meters.** They are on/off per
plan, not quantities to sum. Trying to "meter MCP" is a category error — you gate
whether the tenant may enable it, once, in `features`. DECISIONS §2 already treats
custom tracking domain, dedicated infra, and any-region as dedicated-tier
entitlements; this PRD gives them a home (`features`) instead of leaving them as
scattered `if (plan === "dedicated")` checks (e.g.
`plan-catalog.ts:36-40`, `orgs.ts:20-22`).

Family B vs A is a real fork: A can refuse *before* the cost is incurred (we own
the wire); B can only observe *after* and then coarsely suspend ingest. SMS
segments over a BYO Twilio key are Family B if metered at all (we never see the
send) — the tenant pays Twilio, we cap volume post-hoc. That is why SMS is the
right proof metric (§7): it exercises the "new tenant_db metric, no new column"
path end to end.

### D6 — Stripe: widen `UsageMeter`, keep the ledger and delta-reporting untouched.

`UsageMeter` (`billing/types.ts:106`) widens from the single literal to a union
derived from the registry's `billMeter` values:

```ts
export type UsageMeter = "relay_email_overage";   // + future billable meters
```

(`email_overage` is renamed to `relay_email_overage` for honesty — it is the relay
meter — with the old string kept as a deprecated alias for one release so
in-flight Stripe meter events reconcile.) Everything else in the billing path is
already generic on `meter` and needs no shape change:

- The overage ledger (`email_overage_reports`,
  `src/db/schema/email-usage.ts:46-72`) is already per-`(organization, period)`
  and meter-agnostic in structure. **Generalize it to
  `usage_overage_reports(organization_id, period, meter, …)`** with the unique
  index widened to `(organization_id, period, meter)`, so a second billable meter
  gets its own ledger row rather than a second table. The two-phase
  claim→wire→commit dance (`overage.ts:283-401`) is copied verbatim, parameterized
  by `meter`.
- **Cumulative-DELTA reporting is preserved exactly** (`billing/types.ts:108-128`,
  `overage.ts:325,351-365`): report `pending − reported`, key the Stripe
  `meter_events` identifier on `(org, period, cumulative)`
  (`overage.ts:404-410`), let Stripe dedupe (`stripe.ts:287-317`).
- **The absolute-metric monotonicity caveat.** Delta reporting is only safe while
  the metered value is monotonic within a period. `relay_emails` is monotonic by
  construction (increment-only — `usage-counters.ts:46-47`). A `tenant_db` metric
  is NOT guaranteed monotonic: the sweep SETS it absolutely from a tenant table
  that can shrink (data pruning, a `user_events` retention job, a deleted row). A
  drop would produce a **negative delta**, which a usage meter cannot accept.
  Rule: **any metric with a `billMeter` must be monotonic; a `tenant_db` metric
  may only be given a `billMeter` if the billing reporter clamps its reported
  cumulative to a per-(org,period) running max** — i.e. never report a cumulative
  below `reported_quantity` already committed, mirroring the existing "a meter
  event cannot be withdrawn" drift handling (`overage.ts:222-238`). For the launch
  scope this is moot (only `relay_emails` bills, and it is monotonic), but the
  registry MUST refuse a non-monotonic `billMeter` at boot so a future
  `tenant_db` billable metric cannot silently under/over-report on a prune.

---

## 3. Target schema (Drizzle)

```ts
// src/db/schema/usage-metrics.ts  (new)
import { bigint, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { organizations } from "./organizations";

export const usageMetrics = cloud.table(
  "usage_metrics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Billing period as `YYYY-MM` (UTC) — same key space as the old `month`. */
    period: text("period").notNull(),
    /** A MetricKey from the registry. Not an enum column: adding a metric is a
     *  registry entry, and an enum would drag a migration back into the flow
     *  this table exists to remove. */
    metric: text("metric").notNull(),
    /** Written ABSOLUTELY (tenant_db source) or by INCREMENT (relay source),
     *  never both — the writer is chosen by METRICS[metric].source. */
    value: bigint("value", { mode: "number" }).default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("usage_metrics_env_period_metric_unique_idx").on(
      table.environmentId, table.period, table.metric,
    ),
    index("usage_metrics_org_period_metric_idx").on(
      table.organizationId, table.period, table.metric,
    ),
  ],
);
```

`mode: "number"` for the same reason the old columns use it
(`usage-counters.ts:24-25`): counts stay inside `Number.MAX_SAFE_INTEGER` and a
bigint-as-string would force every caller to parse before arithmetic.

The generalized overage ledger:

```ts
// src/db/schema/usage-overage.ts  (renamed/generalized from email-usage.ts)
export const usageOverageReports = cloud.table(
  "usage_overage_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    meter: text("meter").notNull(),                 // NEW dimension
    reportedQuantity: bigint("reported_quantity", { mode: "number" }).default(0).notNull(),
    pendingQuantity: bigint("pending_quantity", { mode: "number" }),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("usage_overage_reports_org_period_meter_unique_idx").on(t.organizationId, t.period, t.meter)],
);
```

---

## 4. Registry TS shape (summary)

- `src/metering/metrics.ts` — `MetricKey`, `MetricSource`, `MetricDef`,
  `METRICS`, plus `billableMeters()` (derives the `UsageMeter` union at runtime for
  validation) and `assertRegistryInvariants()` run at boot: every `tenant_db`
  metric has a `tenantQuery`; every metric with a `billMeter` is monotonic (i.e.
  `source === "relay"` for now); every `billMeter` is unique across metrics.
- `src/metering/writers.ts` — `setMetric` (absolute, asserts `tenant_db`) and
  `addMetric` (increment, asserts `relay`). Both upsert on the new unique index.
- `src/metering/reads.ts` — `organizationTotals(org, window) → Record<MetricKey,
  number>`, `environmentTotals`, and `windowSum(org, metric, window)`.
- `src/services/plan-limits.ts` — `MetricLimit`, `FeatureKey`, `PlanModel`,
  `PLAN_MODEL: Record<CloudPlan, PlanModel>`, plus back-compat accessors
  `includedFor(plan, metric)`, `hardCapFor(plan, metric)`, `hasFeature(plan, key)`
  so callers migrate incrementally.

---

## 5. Migration path — no downtime, byte-identical numbers

The rule: the cutover must not change a single tenant's reported usage by one
count. Four phases, each independently shippable and reversible.

**M1 — Create alongside.** Add `usage_metrics` and `usage_overage_reports` tables
(new migrations, additive). Ship the registry, `setMetric`/`addMetric`, and the
reads module. Nothing reads the new tables in anger yet. `usage_counters` and
`email_overage_reports` remain the source of truth.

**M2 — Dual-write.** Every write-site writes BOTH:
- The sweep's `upsertUsageCounter` (`usage.ts:134`) also calls
  `setMetric("events", …)` and `setMetric("emails", …)` in the same transaction.
- `recordRelayEmails` (`email-usage.ts:53`) also calls
  `addMetric("relay_emails", …)`.
- The overage reporter writes both ledgers.
Reads still come from the old columns. Run for at least one full sweep cycle plus
one month-close (the `CLOSE_PREVIOUS_PERIOD_MS` window, `sweep.ts:93`). A
reconciliation assertion (a test + an ops query) proves
`usage_metrics` sums equal `usage_counters` columns per `(env, period)` — this is
the byte-identical gate.

**M3 — Flip reads.** Point `organizationTotals`, `readUsageView`, onboarding, and
the relay gate at the registry reads. Old columns still dual-written as a rollback
safety net. Enforcement now judges the new table; verify no tenant's `over` verdict
or ingest flag changed across the flip (the persisted marker
`stacks.ingest_suspended_at` makes this observable — a correct flip flips nobody).

**M4 — Drop columns.** After a stable window on M3, stop dual-writing, drop
`events_count` / `emails_count` / `relay_emails_count` from `usage_counters` (or
drop the table entirely once `email_daily_sends` is moved to its own table — it is
already logically separate, `email-usage.ts` schema), and drop
`email_overage_reports` in favour of `usage_overage_reports`. Keep the deprecated
`email_overage` → `relay_email_overage` Stripe-meter alias one release beyond this.

Rollback at any phase is "stop writing/reading the new table"; the old columns are
authoritative until M4.

---

## 6. Phases + acceptance criteria

### Phase 1 — Registry + tables + writers (BUILD FIRST)

Scope: `usage_metrics` schema, `metrics.ts` registry, `setMetric`/`addMetric`,
reads module, boot-time `assertRegistryInvariants`. M1 + M2 dual-write wired.
`emails`/`events`/`relay_emails` registered.

Acceptance:
- A `tenant_db` metric passed to `addMetric` throws; a `relay` metric passed to
  `setMetric` throws (unit test per direction).
- Dual-write reconciliation test: after a simulated sweep + relay batch,
  `sum(usage_metrics.value) group by metric` equals the corresponding
  `usage_counters` column for every `(env, period)`.
- Boot fails loudly if any `tenant_db` metric lacks a `tenantQuery`, or any
  `billMeter` is attached to a non-monotonic metric, or two metrics share a
  `billMeter`.
- No read-site changed yet; existing 506+ cloud tests stay green.

### Phase 2 — Flip reads + flatten PlanModel (M3)

Scope: `PlanModel` (`limits` + `features`), migrate `organizationTotals`,
`readUsageView`, onboarding, relay gate, and enforcement to registry reads.
`features` map introduced with the already-existing entitlements
(dedicated-only custom domain, region, dedicated infra) moved off scattered
`plan === "dedicated"` checks.

Acceptance:
- `readUsageView` returns per-metric totals and per-metric `over`; the Usage page
  renders every registered metric with a plan cap, and none without one.
- An enforcement run over a seeded fleet produces the identical set of
  `ingest_suspended` / `ingest_resumed` actions as the pre-flip code (golden test
  against `stacks.ingest_suspended_at`).
- `hasFeature(plan, "customDomain")` gates the dashboard/custom-domain surface;
  removing the old inline `plan === "dedicated"` checks changes no behavior
  (test).
- Trial billing-window math (`billingWindow`, `usage.ts:86-104`) unchanged —
  windows still sum across every touched month for trials.

### Phase 3 — Prove with SMS (Family B, new metric, zero DDL)

Scope: register `sms_segments` as a `tenant_db` metric with a `tenantQuery` over
the tenant DB (`sms_sends`), add per-plan `limits.sms_segments`, surface it on the
Usage page. **No schema migration** — that is the whole proof. Gating is Family B:
sweep counts, `reconcileOrganization` suspends ingest on breach. No Stripe meter
(SMS is BYO-Twilio; we cap volume, we do not bill segments).

Acceptance:
- Adding SMS metering is exactly: one `METRICS` entry + one `tenantQuery` + three
  `limits.sms_segments` values (one per tier) + one Usage-page label. Diff touches
  zero migration files and zero writer/reader/enforcement bodies.
- A tenant over its SMS segment cap gets `HOGSEND_INGEST_SUSPENDED` on the same
  path events/emails use; under cap, nothing.
- Usage page shows SMS segments vs cap with the same bar component as events.

### Phase 4 — Drop columns (M4) + Stripe meter generalization

Scope: stop dual-write, drop legacy columns/table, rename `email_overage` →
`relay_email_overage` (alias retained one release), generalize
`email_overage_reports` → `usage_overage_reports`, parameterize the overage
reporter by `meter`.

Acceptance:
- `usage_counters` legacy columns gone; grep for `eventsCount`/`emailsCount`/
  `relayEmailsCount` returns only history.
- Overage reporter is meter-generic; the relay overage numbers reported to Stripe
  in a replay of a real prior month are byte-identical to the pre-rename path.
- Monotonicity guard test: a `tenant_db` metric configured with a `billMeter`
  fails boot; if forced, the reporter clamps a shrunk cumulative to the committed
  running max and never emits a negative delta.

### Deferred (explicitly out of this PRD)

- Actually billing any `tenant_db` metric (events overage, etc.) — needs the
  monotonicity/clamp machinery proven first; register the guard, defer the meter.
- Per-metric warning thresholds beyond email's 80/100 (`plan-limits.ts:56`).
- Seats as a metric — seats are an entitlement/quantity on the org, not a
  per-environment per-period counter; if metered later it is its own model, not
  `usage_metrics`.
- Connector/attribution/funnel/group metering — the registry makes each a
  one-entry add when a business reason appears; none is built here.

---

## 7. Build-first / prove-with-SMS / defer — the split

- **Build first:** the registry, the two guarded writers, the narrow table, and
  the dual-write reconciliation gate (Phase 1). This is pure generalization of
  code that already works; it ships value only once reads flip, but it is the
  foundation and carries the byte-identical proof.
- **Prove with SMS:** Phase 3 is the acceptance test for the whole thesis — a new
  metered feature with no migration and no touch to writer/reader/enforcement
  bodies. If SMS costs more than a registry entry + a query + three limits, the
  abstraction failed and the PRD is wrong.
- **Defer:** billing a `tenant_db` metric, seats, and every currently-unmetered
  engine feature. The point is the *seam*, not lighting up five new invoices.

---

## 8. Risks

- **R1 — A cutover that silently changes a tenant's bill.** Mitigated by the
  dual-write + reconciliation gate (M2) and golden enforcement/overage replays
  (Phase 2/4 acceptance). No column is dropped until the new table has matched the
  old one across a full month-close.
- **R2 — Losing the absolute-vs-increment invariant during refactor.** Mitigated
  by making it a typed `source` field with runtime assertions in both writers
  (D2) — strictly stronger than today's prose comment.
- **R3 — Negative deltas from a non-monotonic billable metric.** Mitigated by the
  boot guard that refuses a `billMeter` on a non-monotonic metric, plus the
  clamp-to-running-max rule (D6). Launch scope only bills `relay_emails`, which is
  monotonic by construction.
- **R4 — `metric` as free text lets a typo create a phantom metric row.** All
  writes go through the registry-keyed writers, which only accept a `MetricKey`;
  a raw string cannot reach the table. The column is text (not an enum) to avoid
  reintroducing migrations, and the registry is the enforced allowlist.
- **R5 — Entitlement scatter.** Moving `plan === "dedicated"` checks into
  `features` risks missing a call-site. Mitigated by grepping the checks and
  gating the move behind a behavior-preserving test per site (Phase 2).
- **R6 — `email_daily_sends` accidental inclusion.** It is deliberately excluded
  (§1 non-goal); a test asserts no registry metric reads or writes
  `email_daily_sends`, keeping the abuse counter and the billing meter disjoint.
