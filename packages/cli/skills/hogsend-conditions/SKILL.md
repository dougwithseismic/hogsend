---
name: hogsend-conditions
description: Use when writing any condition or duration in a Hogsend app — a journey trigger.where, an exitOn rule, or a bucket criteria tree. Covers the four condition types (property, event with a time window + count, email_engagement by template, composite and/or) and DurationObjects via days()/hours()/minutes() instead of magic duration strings.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend conditions & durations

Hogsend has ONE condition engine, shared everywhere you express "does this
user match?" — a journey's `trigger.where`, an `exitOn` rule, and a bucket's
`criteria` tree all speak the same vocabulary. This skill is the single source
of truth for that vocabulary and for the `DurationObject` helpers (`days()`,
`hours()`, `minutes()`) that replace magic duration strings. The journeys and
buckets skills link here for the condition/duration details.

Everything is plain data: a condition is a discriminated-union POJO
(`ConditionEval`), a duration is `{ hours?, minutes?, seconds? }`. You author
them as data or via the fluent `criteriaBuilder` (buckets only) — both produce
byte-identical POJOs. You import these from `@hogsend/core` (re-exported by
`@hogsend/engine`); you never edit the engine.

## The four condition types (`ConditionEval`)

| `type` | Matches on | Key fields |
|--------|-----------|------------|
| `"property"` | a person/event property value | `property`, `operator`, `value?` |
| `"event"` | event occurrences, optionally in a rolling window, optionally counted | `eventName`, `check`, `operator?`, `value?`, `within?` |
| `"email_engagement"` | open/click state of the last send of a template | `templateKey`, `check` |
| `"composite"` | AND / OR over child conditions | `operator` (`"and"`/`"or"`), `conditions[]` |

## Where each surface accepts what (IMPORTANT)

Not every surface accepts all four types — match the type to the field:

- **`trigger.where`** (journey) → `PropertyCondition[]` ONLY. Property
  conditions, AND-ed together, evaluated against the triggering event's
  properties. No event/engagement/composite legs here. Authoring sugar: a
  builder function — `where: (b) => b.prop("score").lte(6)` (or an array of
  terminals) — resolves ONCE at `defineJourney` time to the identical POJOs.
- **`exitOn[].where`** (journey) → `PropertyCondition[]` ONLY. Same shape;
  AND-ed against the incoming event's properties. Omit `where` to exit on the
  event name alone. Accepts the same builder-function sugar.
- **`criteria`** (bucket) → a single `ConditionEval` tree — ALL FOUR types,
  composed with `composite` / `b.all()` / `b.any()`. This is the only surface
  that runs against the database (event counts, engagement, windows).

## Task playbooks — load the matching reference

- **Exact shapes, every operator, the `within` window + count, and how
  `evaluateCondition` reads them** → load `references/condition-types.md`
- **`days()` / `hours()` / `minutes()` `DurationObject`s and where durations
  are valid (sleep, `within`, `entryPeriod`, dwell)** → load
  `references/durations.md`
- **Copy-paste `trigger.where`, `exitOn`, and bucket `criteria` built from the
  real builder + types** → load `references/examples.md`

## Golden rules

1. `trigger.where` and `exitOn[].where` take `PropertyCondition[]` (write them
   with the `(b) => b.prop(...)` builder for short) — if
   you need an event count or a time window, that logic belongs in the
   journey's `run` body (`ctx.history.hasEvent`) or in a bucket's `criteria`,
   not in `where`.
2. Use the duration helpers — never hand-write `{ hours: 168 }`; write
   `days(7)`.
3. A dynamic bucket's `criteria` MUST contain at least one positive condition;
   a pure-negation tree is rejected at registration.
4. To author/run a journey or bucket end to end, see the
   hogsend-authoring-journeys and hogsend-authoring-buckets skills; to verify a
   running instance, see the hogsend-cli skill.
