# Scheduling, Timezones & Frequency Capping — Implementation Spec

Status: LOCKED design. This document is the implementation contract. An
implementer should be able to follow it without guessing. Everything here is
**additive** — no breaking changes to `apps/api` or consumer-facing types.

Constraints (carried from the directives):

- No `git commit` / `git push` (the lead handles git).
- No Supabase commands. Migrations are **generated as files**, not applied.
- Add deps with `pnpm add <pkg>@latest --filter <workspace>` — never hand-edit
  version numbers into a `package.json`.
- Biome style: 2-space indent, double quotes, semicolons, 80-col. Engine is ESM
  with `.js` extensions on relative imports. Node 22 target.
- Do **not** reintroduce the rejected three-resolver shape
  (`nextLocalTime` / `nextWeekday` / `withinSendWindow` as separate public
  functions). The public scheduling surface is exactly one fluent builder.

---

## 0. Summary of the final API surface

```ts
// --- packages/core/src/types/journey-context.ts (additive) ---

interface JourneyContext {
  // ...existing members unchanged...

  /** Durable sleep until an absolute instant. */
  sleepUntil(
    at: Date | string,
    opts?: { label?: string },
  ): Promise<{ sleptAt: string; resumedAt: string }>;

  /** Timezone-bound fluent scheduler. Always terminates in a `Date`. */
  when: WhenBuilder;
}

interface WhenBuilder {
  next(weekday: Weekday): TimeOfDayBuilder; // upcoming named weekday
  nextLocal(time: string): Date; // next HH:mm local (shortcut)
  tomorrow(): TimeOfDayBuilder;
  in(duration: DurationObject): TimeOfDayBuilder; // N from now
  tz(timezone: string): WhenBuilder; // per-call tz override
  window(start: string, end: string): WhenBuilder; // per-call send window
  ifPast(strategy: IfPast): WhenBuilder; // default "next"
}

interface TimeOfDayBuilder {
  at(time: string): Date; // "HH:mm", returns the resolved instant
}

type Weekday =
  | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday"
  | "saturday" | "sunday";

type IfPast = "next" | "now"; // "next": roll forward; "now": clamp to current instant
```

```ts
// --- packages/core/src/schedule/index.ts (NEW, pure, unit-tested) ---

interface ScheduleOptions {
  timezone: string; // resolved IANA tz
  now: Date; // explicit current instant (testability)
  window?: { start: string; end: string }; // optional quiet-hours window
  ifPast?: IfPast; // default "next"
}

function resolveNextLocalTime(time: string, opts: ScheduleOptions): Date;
function resolveNextWeekday(
  weekday: Weekday,
  time: string,
  opts: ScheduleOptions,
): Date;
function resolveTomorrow(time: string, opts: ScheduleOptions): Date;
function resolveAfter(
  duration: DurationObject,
  time: string,
  opts: ScheduleOptions,
): Date;
function clampToWindow(
  instant: Date,
  window: { start: string; end: string },
  timezone: string,
): Date;
function isValidTimeZone(tz: string): boolean;
```

```ts
// --- packages/engine: client defaults + frequency cap + result fields ---

interface HogsendClientOptions {
  // ...existing members unchanged...
  defaults?: {
    timezone?: string; // global fallback tz, e.g. "UTC"
    sendWindow?: { start: string; end: string }; // "HH:mm".."HH:mm"
    frequencyCap?: FrequencyCapConfig;
  };
}

interface FrequencyCapConfig {
  count: number;
  window: DurationObject;
  byCategory?: Record<string, { count: number; window: DurationObject }>;
  exemptCategories?: string[]; // defaults to ["transactional"]
}

// TrackedSendResult — extended additively
interface TrackedSendResult {
  emailSendId: string;
  resendId: string;
  status: "sent" | "suppressed" | "unsubscribed" | "skipped";
  reason?: "frequency_capped";
}
```

```ts
// --- packages/engine timezone resolution ---
function resolveTimezone(input: ResolveTimezoneInput): string;

interface ResolveTimezoneInput {
  explicit?: string; // from .tz()
  posthogProperties?: Record<string, unknown>; // person props
  contactTimezone?: string | null; // contacts.timezone column
  contactProperties?: Record<string, unknown> | null; // contacts.properties jsonb
  defaultTimezone?: string; // client defaults.timezone
  logger?: { warn(msg: string): void };
}
```

---

## 1. Exact TypeScript signatures

### 1.1 `ctx.sleepUntil`

Interface (`packages/core/src/types/journey-context.ts`):

```ts
export interface SleepUntilOptions {
  label?: string;
}

export interface JourneyContext {
  // ...existing...
  sleepUntil(
    at: Date | string,
    opts?: SleepUntilOptions,
  ): Promise<SleepResult>; // SleepResult = { sleptAt: string; resumedAt: string }
}
```

Behaviour (impl in `packages/engine/src/journeys/journey-context.ts`):

1. Parse `at`: a `Date` is used as-is; a `string` is parsed with `new Date(at)`.
   If the parse yields `NaN`, throw `TypeError("sleepUntil: invalid date")`
   (programmer error, not a runtime fall-through case).
2. `const target = at instanceof Date ? at.getTime() : new Date(at).getTime();`
3. `const ms = Math.max(0, target - Date.now());` — computed **once**.
4. Set `journeyStates.status = "waiting"`, `currentNodeId = label ?? "wait-until:<ISO>"`.
5. `await hatchetCtx.sleepFor(ms);` (number-ms; Hatchet preserves the wake
   deadline across replays/restarts — durability comes from Hatchet, the `ms`
   is only computed for the initial schedule).
6. Set `journeyStates.status = "active"`.
7. Return `{ sleptAt, resumedAt }` ISO strings, mirroring `ctx.sleep`.

A past instant gives `ms = 0` → effectively immediate.

### 1.2 `ctx.when` builder surface

Interface (`packages/core/src/types/journey-context.ts`):

```ts
export type Weekday =
  | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday"
  | "saturday" | "sunday";

export type IfPast = "next" | "now";

export interface TimeOfDayBuilder {
  /** Resolve to an absolute instant at `time` ("HH:mm") in the bound tz. */
  at(time: string): Date;
}

export interface WhenBuilder {
  /** Upcoming named weekday; chain `.at("HH:mm")`. */
  next(weekday: Weekday): TimeOfDayBuilder;
  /** Next occurrence of `time` local (today if still future, else tomorrow). */
  nextLocal(time: string): Date;
  /** Tomorrow in the bound tz; chain `.at("HH:mm")`. */
  tomorrow(): TimeOfDayBuilder;
  /** `duration` from now, snapped to `.at("HH:mm")` on that day. */
  in(duration: DurationObject): TimeOfDayBuilder;
  /** Override the resolved user tz for this chain only. Returns a new builder. */
  tz(timezone: string): WhenBuilder;
  /** Override the default send window for this chain. Returns a new builder. */
  window(start: string, end: string): WhenBuilder;
  /** How to treat an already-past resolved time. Default "next". */
  ifPast(strategy: IfPast): WhenBuilder;
}
```

Every terminal method (`nextLocal`, `.at(...)`) returns a **`Date`** (an absolute
instant). `tz` / `window` / `ifPast` are chainable refinements that return a new
`WhenBuilder` carrying the override; they never return `Temporal` types — Temporal
is an internal implementation detail of `packages/core/src/schedule/`.

The builder is constructed per journey context with the user's resolved tz and
the client default window already bound, so journey authors **never pass a tz**.

### 1.3 Pure core/schedule functions

All in `packages/core/src/schedule/`. Every function takes an **explicit
timezone** and an **explicit current instant** so they are deterministic and
unit-testable. No `Date.now()`, no ambient tz.

```ts
import type { DurationObject } from "../duration.js";

export type Weekday = /* re-exported from types */;
export type IfPast = "next" | "now";

export interface ScheduleOptions {
  /** Resolved IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Explicit "current" instant. */
  now: Date;
  /** Optional quiet-hours window in the same tz. */
  window?: { start: string; end: string };
  /** Behaviour when the naive resolved instant is already <= now. */
  ifPast?: IfPast; // default "next"
}

/** Next occurrence of HH:mm local. today if still future (per ifPast), else +1 day. */
export function resolveNextLocalTime(
  time: string,
  opts: ScheduleOptions,
): Date;

/** Upcoming `weekday` at HH:mm local. If today IS the weekday and time future,
 *  returns today; otherwise the next matching weekday (1..7 days ahead). */
export function resolveNextWeekday(
  weekday: Weekday,
  time: string,
  opts: ScheduleOptions,
): Date;

/** Tomorrow (now + 1 calendar day in tz) at HH:mm local. */
export function resolveTomorrow(time: string, opts: ScheduleOptions): Date;

/** `now` + duration, then snapped to HH:mm local on the resulting calendar day. */
export function resolveAfter(
  duration: DurationObject,
  time: string,
  opts: ScheduleOptions,
): Date;

/** Map an instant into the open window. No-op if already open. */
export function clampToWindow(
  instant: Date,
  window: { start: string; end: string },
  timezone: string,
): Date;

/** True if `tz` is a usable IANA zone (probed via Temporal/Intl). Never throws. */
export function isValidTimeZone(tz: string): boolean;

/** Parse "HH:mm" → { hour, minute }; throws on malformed input (author error). */
export function parseTimeOfDay(time: string): { hour: number; minute: number };
```

Each resolver: builds a `Temporal.ZonedDateTime` from `now` in `opts.timezone`,
computes the target `PlainDate`/`PlainTime`, combines them with disambiguation
`"compatible"` (see §3), applies `ifPast`, then (if `opts.window` set) runs
`clampToWindow`, and finally returns `new Date(zdt.epochMilliseconds)`.

### 1.4 `resolveTimezone`

`packages/engine/src/lib/timezone.ts` (NEW):

```ts
export interface ResolveTimezoneInput {
  explicit?: string;
  posthogProperties?: Record<string, unknown>;
  contactTimezone?: string | null;
  contactProperties?: Record<string, unknown> | null;
  defaultTimezone?: string;
  logger?: { warn(msg: string): void };
}

/** Never throws. Validates each candidate; invalid ones are skipped + warned. */
export function resolveTimezone(input: ResolveTimezoneInput): string;
```

Precedence (first **valid** candidate wins, see §3 for the chain):
`explicit` → `posthogProperties.$timezone` → `posthogProperties.$geoip_time_zone`
→ `contactTimezone` → `contactProperties.timezone` → `defaultTimezone` → `"UTC"`.
Validity is checked with `isValidTimeZone`; an invalid candidate is skipped and a
`logger?.warn` is emitted (`"resolveTimezone: ignoring invalid tz '<x>'"`).

### 1.5 Client defaults shape

`packages/engine/src/container.ts` — `HogsendClientOptions`:

```ts
defaults?: {
  timezone?: string;                          // default "UTC"
  sendWindow?: { start: string; end: string }; // "HH:mm".."HH:mm"
  frequencyCap?: FrequencyCapConfig;
};
```

`FrequencyCapConfig` (in `email-service-types.ts`):

```ts
export interface FrequencyCapWindow {
  count: number;
  window: DurationObject;
}

export interface FrequencyCapConfig {
  count: number;
  window: DurationObject;
  byCategory?: Record<string, FrequencyCapWindow>;
  exemptCategories?: string[]; // default ["transactional"]
}
```

### 1.6 Additive send-result fields

`packages/engine/src/lib/email-service-types.ts`:

```ts
export interface TrackedSendResult {
  emailSendId: string;
  resendId: string;
  status: "sent" | "suppressed" | "unsubscribed" | "skipped"; // + "skipped"
  reason?: "frequency_capped"; // present only when skipped by the cap
}
```

`SendEmailResult` (`email.ts`) is unchanged in shape but its `emailSendId` may now
reference a row that was never dispatched — journeys treat a capped send the same
as a suppressed one (continue gracefully). `sentAt` remains set to "now" for
backward-compat (callers do not branch on it today).

---

## 2. File-by-file change list

### packages/core

| Path | Change |
| --- | --- |
| `package.json` | Add dep `@js-temporal/polyfill` via `pnpm add @js-temporal/polyfill@latest --filter @hogsend/core`. Add `"./schedule": "./src/schedule/index.ts"` to `exports`. Add `vitest`/`@vitest/* ` devDeps + `"test": "vitest run"`, `"test:watch": "vitest"` scripts (this package has no vitest today). |
| `vitest.config.ts` | **NEW** minimal config (`test: { environment: "node" }`). |
| `src/schedule/index.ts` | **NEW** module barrel — re-exports everything from `time.ts`, `resolvers.ts`, `window.ts`, `tz.ts`. |
| `src/schedule/time.ts` | **NEW** `parseTimeOfDay`, weekday name→ISO-weekday (1..7) map, `Weekday`/`IfPast` types (or re-import from `../types`). |
| `src/schedule/tz.ts` | **NEW** `isValidTimeZone` (probe `new Intl.DateTimeFormat(undefined,{timeZone}).format()` inside try/catch, or `Temporal.TimeZone.from`). |
| `src/schedule/window.ts` | **NEW** `clampToWindow` (algorithm §4). |
| `src/schedule/resolvers.ts` | **NEW** `resolveNextLocalTime`, `resolveNextWeekday`, `resolveTomorrow`, `resolveAfter`, `ScheduleOptions`. All Temporal-based, disambiguation `"compatible"`. |
| `src/types/journey-context.ts` | **EDIT** add `SleepUntilOptions`, `Weekday`, `IfPast`, `TimeOfDayBuilder`, `WhenBuilder`; add `sleepUntil(...)` and `when: WhenBuilder` to `JourneyContext`. |
| `src/index.ts` | **EDIT** add `export * from "./schedule/index.js";` (and the new types flow out via the existing `export * from "./types/index.js"`). |

### packages/engine

| Path | Change |
| --- | --- |
| `src/journeys/journey-context.ts` | **EDIT** widen `hatchetCtx` type to `{ sleepFor: (d: DurationObject \| number) => Promise<unknown> }`. Add `sleepUntil` impl (§1.1). Add `when` builder impl (§1.2) — a thin wrapper that injects the resolved tz + `Date.now()` + default window into the pure resolvers. Accept new config fields: `resolvedTimezone: string`, `defaultSendWindow?: { start; end }`. |
| `src/journeys/define-journey.ts` | **EDIT** at the `createJourneyContext(...)` call site (~L130): resolve the user's tz via `resolveTimezone(...)` (using PostHog person props if `posthog` present, the contact row, and client defaults) and pass `resolvedTimezone` + `defaultSendWindow` into the context config. Opportunistically write the resolved tz back to `contacts.timezone` when it came from PostHog and the column is empty (cache write, best-effort, non-blocking). |
| `src/lib/timezone.ts` | **NEW** `resolveTimezone` + `ResolveTimezoneInput` (§1.4). Uses `isValidTimeZone` from `@hogsend/core/schedule`. |
| `src/container.ts` | **EDIT** add `defaults?` to `HogsendClientOptions`. Thread `defaults.frequencyCap` into `createTrackedMailer` config; thread `defaults.timezone` / `defaults.sendWindow` into a place reachable by `define-journey` (store on the returned `HogsendClient` as `defaults`, and/or pass into the journey-context wiring). |
| `src/container.ts` (`HogsendClient`) | **EDIT** add `defaults: { timezone: string; sendWindow?: {...}; frequencyCap?: FrequencyCapConfig }` to the client object so `define-journey` can read it. |
| `src/lib/email-service-types.ts` | **EDIT** extend `TrackedSendResult` (§1.6). Add `FrequencyCapConfig`/`FrequencyCapWindow`. Add `frequencyCap?: FrequencyCapConfig` to `EmailServiceConfig`. |
| `src/lib/mailer.ts` | **EDIT** read `config.frequencyCap`; pass it into `sendTrackedEmail`. |
| `src/lib/tracked.ts` | **EDIT** add the frequency-cap check (§5) **after** the suppression block (after L71) and **before** the render/insert/`provider.send` (before L81). On cap hit: insert no `sent` row (insert a `status: "failed"`-style audit row is **out of scope** — return without inserting; see §5 for the chosen variant), return `{ status: "skipped", reason: "frequency_capped", emailSendId: "", resendId: "" }`. Add `frequencyCap?: FrequencyCapConfig` to `TrackedEmailDeps`. |
| `src/lib/frequency-cap.ts` | **NEW** `isFrequencyCapped({ db, to, category, config }): Promise<boolean>` — the single indexed `COUNT` query + category/exemption logic (§5). |
| `src/index.ts` | **EDIT** re-export `resolveTimezone`, `FrequencyCapConfig`, and (for journey authors) the new context types flow through `@hogsend/core`. Confirm `TrackedSendResult` re-export still covers the new fields (it does — it's a type re-export). |

### packages/db

| Path | Change |
| --- | --- |
| `src/schema/contacts.ts` | **EDIT** add `timezone: text("timezone")` (nullable). Document as an opportunistic cache (PostHog/JSONB remain authoritative). |
| `src/schema/email-sends.ts` | **EDIT** add a composite index for the cap query: `index("email_sends_freq_cap_idx").on(table.toEmail, table.createdAt, table.category)`. |
| `drizzle/0009_*.sql` (+ `meta/0009_snapshot.json`, `meta/_journal.json` entry) | **GENERATED** via `pnpm --filter @hogsend/db db:generate` after the two schema edits. Do **not** hand-edit the journal/snapshots. Expected SQL: `ALTER TABLE "contacts" ADD COLUMN "timezone" text;` + `CREATE INDEX "email_sends_freq_cap_idx" ON "email_sends" ("to_email","created_at","category");`. This lands on the **ENGINE** track (bundled in `@hogsend/db`). Generate the file but **do not apply** it. |

### apps/api

No source changes required (everything additive). Its existing tests must still
type-check and pass unchanged. If any test constructs a partial `JourneyContext`
mock, it must be widened to include `sleepUntil` + `when` (verify in §6).

---

## 3. DST / ambiguous-time handling, tz precedence, validity

### 3.1 Temporal disambiguation

All wall-clock → instant conversions use Temporal with disambiguation
`"compatible"`:

```ts
const zdt = plainDate
  .toPlainDateTime(plainTime)
  .toZonedDateTime(timezone, { disambiguation: "compatible" });
```

`"compatible"` is the JS-`Date`-equivalent rule and the documented choice:

- **Spring-forward gap** (e.g. 02:30 on a day clocks jump 02:00→03:00 and 02:30
  does not exist): `"compatible"` picks the **later** instant (the time after the
  gap, i.e. 03:30 wall-clock equivalent). Documented as "first valid instant
  going forward".
- **Fall-back overlap** (e.g. 01:30 occurs twice): `"compatible"` picks the
  **first** (earlier) occurrence.

This MUST be commented in `resolvers.ts` for maintainability.

### 3.2 Timezone precedence chain (`resolveTimezone`)

First **valid** candidate wins; invalid candidates are skipped + warned, never
thrown:

1. `explicit` — the per-call `.tz("Area/City")`.
2. `posthogProperties.$timezone` — device IANA tz from PostHog person props.
3. `posthogProperties.$geoip_time_zone` — GeoIP-derived tz.
4. `contactTimezone` — the new `contacts.timezone` column (cache).
5. `contactProperties.timezone` — `contacts.properties` jsonb fallback.
6. `defaultTimezone` — `client.defaults.timezone`.
7. `"UTC"` — terminal default.

A candidate is "valid" iff `isValidTimeZone(candidate) === true` and it is a
non-empty string. `isValidTimeZone` probes the zone (`Intl.DateTimeFormat` /
`Temporal.TimeZone.from`) inside try/catch and returns a boolean — it never
throws on garbage input.

### 3.3 Opportunistic cache write

When `resolveTimezone` resolved a value from a PostHog source (steps 2–3) and
`contacts.timezone` is currently null, `define-journey` best-effort writes that
value into the column (fire-and-forget, errors swallowed). The JSONB/PostHog
sources remain authoritative; the column is never read as a source of truth above
PostHog, matching the precedence order.

---

## 4. Quiet-hours clamping algorithm (`clampToWindow`)

Inputs: an absolute `instant` (`Date`), a `window = { start: "HH:mm", end: "HH:mm" }`,
and the `timezone`. Output: a `Date` inside the open window.

Definitions in the zone:

- `open = today's start time`, `close = today's end time` as `ZonedDateTime`s
  derived from the instant's `PlainDate` in `timezone`.
- **Normal window** (`start < end`, e.g. `09:00`–`17:00`): "open" means
  `open <= instant < close`.
- **Overnight window** (`start > end`, e.g. `22:00`–`06:00`): the window wraps
  midnight; "open" means `instant >= open` **or** `instant < close`.
- `start === end` is treated as "always open" (no clamping).

Algorithm:

```
zdt = instant in timezone
(openH, openM)  = parse(window.start)
(closeH, closeM) = parse(window.end)

if start == end: return instant            // always open

if normal window (start < end):
  todayOpen  = zdt.date at openH:openM
  todayClose = zdt.date at closeH:closeM
  if zdt <  todayOpen:  return instant(todayOpen)        // before open → snap to today's open
  if zdt >= todayClose: return instant(tomorrowOpen)     // after close → next day's open
  return instant                                          // already open

else (overnight window, start > end):
  todayClose = zdt.date at closeH:closeM        // morning close
  todayOpen  = zdt.date at openH:openM          // evening open
  if zdt < todayClose: return instant            // in the early-morning open tail
  if zdt >= todayOpen: return instant            // in the late-evening open head
  // we are in the quiet daytime gap [close, open)
  return instant(todayOpen)                       // snap forward to tonight's open
```

All `ZonedDateTime` construction uses disambiguation `"compatible"` (so the
window edge itself is DST-safe). "snap to next day's open" uses
`zdt.add({ days: 1 })` then re-applies the open time, so DST day-length changes
are handled by Temporal calendar arithmetic, not by adding 24h of millis.

The resolvers call `clampToWindow` as their **last** step (after `ifPast`), so the
returned instant is guaranteed inside the window. `ctx.when` applies the client
default window automatically; `.window(start, end)` overrides it for the chain.
**Clamping happens only here, at the scheduling layer — never in the mailer.**
Immediate transactional sends do not go through `ctx.when`, so they bypass windows
entirely.

---

## 5. Frequency-cap algorithm

Lives in `packages/engine/src/lib/frequency-cap.ts`, called from `sendTrackedEmail`
**after** the suppression block and **before** the `email_sends` insert +
`provider.send`.

```ts
export async function isFrequencyCapped(opts: {
  db: Database;
  to: string;
  category?: string;
  config?: FrequencyCapConfig;
}): Promise<boolean>;
```

Logic:

1. If `config` is undefined → return `false` (feature is opt-in per client; safe
   default = no capping).
2. Resolve `exempt = config.exemptCategories ?? ["transactional"]`. If
   `category` is set and `exempt.includes(category)` → return `false` (exempt).
   Also respect `skipPreferenceCheck` at the call site: if a system send sets
   `skipPreferenceCheck`, the cap is **not** consulted (consistent with
   suppression being skipped for system mail).
3. Pick the effective rule:
   - If `category` is set and `config.byCategory?.[category]` exists → use that
     `{ count, window }` **and** filter the count by `category = <category>`.
   - Else → use the global `{ config.count, config.window }` and count **all**
     of this recipient's sends in the window (no category filter). `NULL`
     category rows are included in the global count.
4. Compute `since = new Date(Date.now() - durationToMs(window))`.
5. Single indexed `COUNT`:

```sql
SELECT count(*) FROM email_sends
WHERE to_email = $to
  AND created_at >= $since
  [AND category = $category]   -- only for the byCategory branch
  AND status <> 'failed';      -- don't count never-dispatched / failed rows
```

   Drizzle: `db.select({ n: count() }).from(emailSends).where(and(...))`.
   This is served by the new `email_sends_freq_cap_idx (to_email, created_at,
   category)`.
6. Return `n >= rule.count`.

Skip semantics in `sendTrackedEmail` when capped:

- Do **not** call `provider.send`.
- Do **not** insert a `sent` row. (Chosen variant: insert **no** row at all, so
  a capped send leaves no `email_sends` artifact and cannot itself contribute to
  future cap counts. `emailSendId` returns `""`.)
- Do **not** throw.
- `logger`/console: log at info/debug
  (`"send skipped: frequency_capped to=<to> category=<category>"`). Use the
  logger already available to the mailer if present; otherwise this is a no-op
  log hook — do not add a new logger dependency just for this.
- Return:

```ts
return {
  emailSendId: "",
  resendId: "",
  status: "skipped",
  reason: "frequency_capped",
};
```

Callers: `sendEmail` (`email.ts`) returns `{ emailSendId: result.emailSendId,
sentAt }` unchanged — a journey sees a benign result and continues. Type-safe
callers (`container.emailService.send`) get the additive `status: "skipped"` and
may branch if they wish (not required).

---

## 6. Test plan

Add vitest to `packages/core` (none today). Engine tests live in
`apps/api/src/__tests__/` (consumer harness; calls into the engine) or a new
engine-local vitest config — prefer extending the existing `apps/api` suite for
integration-style engine tests since that's the established pattern, and add a
new `packages/core/vitest.config.ts` for the pure unit tests.

### 6.1 Unit tests — `packages/core/src/schedule` (pure, deterministic)

All cases pass an **explicit** `now` and `timezone` (no `Date.now`, no ambient
tz). Use fixed instants and assert on the returned `Date`'s `toISOString()` /
epoch.

**`resolveNextLocalTime`**

- now = 2026-06-01T10:00 local, time "14:00" → same day 14:00.
- now = 2026-06-01T15:00 local, time "14:00", ifPast "next" → next day 14:00.
- now = 2026-06-01T15:00 local, time "14:00", ifPast "now" → returns `now`.
- Exact equality: now == target instant → with ifPast "next" rolls forward.

**`resolveNextWeekday`** (weekday + name forms)

- "tuesday" / "tue" parse to the same ISO weekday.
- now = Mon, next "tuesday" 08:00 → tomorrow.
- now = Tuesday 06:00, next "tuesday" 08:00 → **today** 08:00 (same-day future).
- now = Tuesday 09:00, next "tuesday" 08:00 → **next** Tuesday (7 days).
- now = Sunday, next "monday" → tomorrow (week wrap).
- Full-name + short-name produce identical instants.

**DST cases** (use `America/New_York`, transitions 2026-03-08 spring-forward,
2026-11-01 fall-back):

- Spring-forward gap: resolve 02:30 on 2026-03-08 → Temporal `"compatible"`
  yields the post-gap instant; assert the resulting UTC offset is `-04:00` (EDT),
  not `-05:00`, i.e. the local wall time effectively maps to 03:30.
- Fall-back overlap: resolve 01:30 on 2026-11-01 → assert the **earlier**
  (EDT, `-04:00`) of the two 01:30 instants is chosen.
- `resolveTomorrow` across a DST boundary: now = 2026-03-07T23:00 EST, tomorrow
  08:00 → assert it's 08:00 wall-clock on 2026-03-08 with offset `-04:00` (uses
  calendar `add({days:1})`, not +24h millis).

**`resolveAfter`**

- now = day X 10:00, `in(days(2)).at("08:00")` → day X+2 at 08:00 local.
- `in({ hours: 1 })` crossing midnight → snaps to next day's HH:mm correctly.

**`clampToWindow`** (window-clamp cases)

- Normal window 09:00–17:00, instant 12:00 → unchanged.
- instant 07:00 (before open) → snapped to **today** 09:00.
- instant 19:00 (after close) → snapped to **tomorrow** 09:00.
- instant exactly 17:00 (== close) → after-close → tomorrow 09:00 (close is
  exclusive).
- instant exactly 09:00 (== open) → unchanged (open is inclusive).
- Overnight window 22:00–06:00: instant 23:00 → unchanged (open tail);
  instant 03:00 → unchanged (early-morning open); instant 12:00 (quiet gap) →
  snapped forward to **today** 22:00.
- `start === end` → always-open → unchanged.
- Window edge across a DST day: snap-to-next-day uses `add({days:1})` so a
  23/25-hour day still lands on HH:mm wall-clock.

**`isValidTimeZone`**

- "America/New_York" → true; "UTC" → true; "Not/AZone" → false; "" → false;
  garbage → false (never throws).

**`resolveTimezone`** (engine unit test, `packages/engine` or `apps/api`)

- explicit wins over PostHog.
- PostHog `$timezone` wins over `$geoip_time_zone`.
- falls to `contactTimezone`, then `contactProperties.timezone`, then default,
  then "UTC".
- invalid explicit tz is skipped (warn fired) and the next valid candidate wins.
- all-invalid → "UTC", no throw.

### 6.2 Engine / integration tests

**`ctx.sleepUntil`** (mock the durable task + Hatchet, mirroring
`apps/api/src/__tests__/journeys.test.ts` which `vi.mock`s `hatchet.durableTask`
and `sendEmailTask`):

- Fake clock: `vi.useFakeTimers()` / `vi.setSystemTime(fixedDate)`.
- Fake `hatchetCtx.sleepFor` as `vi.fn()` resolving immediately; assert it was
  called with the **number** `ms = max(0, target - now)`.
- `sleepUntil(futureDate)` → asserts `sleepFor` got the positive ms;
  `journeyStates.status` transitioned `waiting` → `active` (assert the two
  `db.update` calls, same pattern as existing `sleep` if covered, or via a mock
  db spy).
- `sleepUntil(pastDate)` → `sleepFor` called with `0`.
- `sleepUntil("not-a-date")` → throws `TypeError`.
- `sleepUntil(new Date(...))` and `sleepUntil(isoString)` produce identical ms.

**`ctx.when`** (thin-wrapper test): construct a context bound to a known tz +
window with `vi.setSystemTime`, assert `ctx.when.next("tuesday").at("08:00")`,
`ctx.when.nextLocal("08:00")`, `ctx.when.tomorrow().at("08:00")`,
`ctx.when.in(days(2)).at("08:00")` all return `Date`s equal to the corresponding
pure-resolver output (the wrapper just injects tz + now + default window). Assert
`.tz(...)` / `.window(...)` overrides change the result accordingly.

**Frequency-cap skip** (needs a DB — existing `mailer.test.ts` uses
`createResendProvider` with **no** db, so add a mock/in-memory db or a `db`
override):

- Mock `db` so the cap `COUNT` query returns `n >= cap` → `sendTrackedEmail`
  returns `{ status: "skipped", reason: "frequency_capped" }`, `provider.send`
  is **not** called (assert the provider mock has 0 calls), and no `email_sends`
  insert with `status: "sent"` occurs.
- Count `< cap` → normal send path (provider called once, `status: "sent"`).
- `category` in `exemptCategories` (default "transactional") → cap **not**
  consulted; provider called.
- `byCategory` override applies a different count/window than the global rule;
  assert the query filters by category.
- `skipPreferenceCheck: true` → cap not consulted (system send).

### 6.3 Faking Hatchet / clock

- **Clock:** `vi.useFakeTimers()` + `vi.setSystemTime(new Date("2026-06-01T..."))`
  in engine tests; pure core tests take `now` explicitly so they need no fake
  clock.
- **Hatchet:** reuse the existing pattern — `vi.mock` the durable-task factory and
  pass a `hatchetCtx` stub `{ sleepFor: vi.fn().mockResolvedValue(undefined),
  workflowRunId: () => "test-run" }`. `sleepUntil` only needs `sleepFor`; assert
  on its call args. No real Hatchet engine, no real gRPC.
- **DB:** for frequency-cap tests, inject a `db` test double whose
  `select(...).from(...).where(...)` resolves a controllable `count`, and whose
  `insert`/`update` are spies — or use the `overrides.db` / `overrides.mailer`
  seams already in `createHogsendClient`.

### 6.4 Compat assertion

`apps/api` must still `pnpm check-types` and `pnpm --filter @hogsend/api test`
green with **zero** source changes. The only allowed test edit is widening any
hand-rolled partial `JourneyContext` mock to include `sleepUntil` + `when`.

---

## 7. Implementation order (suggested, non-binding)

1. `packages/core/src/schedule/*` + unit tests (pure, no other deps; add Temporal
   dep + vitest first).
2. Core types (`sleepUntil`, `when`) + core index export.
3. `packages/db` schema edits + `db:generate` (generate file, do not apply).
4. `resolveTimezone` (`engine/src/lib/timezone.ts`).
5. `journey-context.ts` (`sleepUntil`, `when` wrapper, widened `hatchetCtx`) +
   `define-journey.ts` tz wiring + opportunistic cache write.
6. `container.ts` defaults plumbing.
7. Frequency cap (`frequency-cap.ts`, `tracked.ts`, `mailer.ts`, result types).
8. Engine/integration tests.
9. `pnpm lint`, `pnpm check-types`, both test suites.
