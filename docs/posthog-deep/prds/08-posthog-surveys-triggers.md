# PRD 08 — `posthog-surveys-triggers`

**Depends on:** 00 (`posthog-identity-map` — for cases where the survey's own identity
signal needs the mapped-alias resolver rather than the raw `distinct_id` shortcut the
existing webhook path already uses). **Status:** `[ ]`

## Goal

Let a PostHog survey response drive a Hogsend journey trigger (the brief's example: an
NPS detractor response enrolls a save-the-account journey). **Not in scope:** PostHog
feature flags as journey conditions — cut by the user, DECISIONS §3 non-goal 2. This PRD
is surveys only.

## What recon found: this is nearly free, and here is exactly why

**Verified**: the existing consumer webhook source, `apps/api/src/webhook-sources/posthog.ts`
(1-75, full file read), already transforms **any** PostHog event forwarded through a
PostHog webhook destination, generically:

```ts
// posthog.ts:45-74
async transform(payload) {
  const eventName = payload.event.event;        // whatever PostHog sends — no filtering
  const userId = payload.event.distinct_id;
  const rawEmail = payload.person?.properties?.email;
  ...
  return {
    event: eventName,
    userId,
    userEmail,
    eventProperties,       // = { ...payload.event.properties, _posthogEventId? }
    contactProperties,      // = { ...payload.person?.properties }
  };
}
```

There is **no event-name allowlist or filter anywhere in this transform** — `eventName`
is passed through verbatim from `payload.event.event`, and `eventProperties` is passed
through verbatim from `payload.event.properties` (`posthog.ts:55-61`). PostHog's own
survey instrumentation (`posthog-js`'s survey feature) emits its response events —
`"survey sent"`, `"survey shown"`, `"survey dismissed"` — as **ordinary PostHog captured
events**, carrying properties like `$survey_id`, `$survey_name`, and the response value(s)
(commonly `$survey_response` for a single-question survey, or `$survey_response_<index>`
for multi-question surveys). [EXTERNAL KNOWLEDGE — PostHog's own survey event schema is
not present anywhere in this repo; I have not verified these exact property names against
a live PostHog project or its current docs. Flagging this explicitly as the one load-bearing
fact in this PRD that is NOT grounded in this codebase and needs a human check against a
real PostHog survey (see Seams).] Because this transform has no event-name filter, **if an
operator's PostHog project already has a webhook destination (or a Workflow forwarding
survey events) pointed at this source's URL, survey response events are already flowing
through `ingestEvent` today, with zero code changes.**

**This directly shrinks the PRD**, as anticipated in the assigning brief: there is no new
transform logic to write for the ingestion half. What remains is (a) confirming this
claim against a real project (a human-verification seam, not something this PRD can prove
purely by reading code), (b) an authoring ergonomic so a journey can trigger on "NPS
detractor" without an author having to know PostHog's raw survey-response property naming
convention, and (c) closing one real gap the existing generic transform has for surveys
specifically (see D2).

## Locked decisions

### D1 — Reuse the existing webhook path verbatim; do not build a second ingestion route

**[PROPOSED]** No new webhook source, no new route. Survey response events arrive at the
SAME `POST /v1/webhooks/posthog` the existing `posthogSource` already serves (per
CLAUDE.md's webhook-source system: `POST /v1/webhooks/:sourceId`), through the SAME
`posthogWebhookSchema`/`transform` (`posthog.ts:25-74`). This is possible specifically
because that transform is event-name-agnostic — building a second, survey-specific
webhook source would duplicate the auth/schema/transform machinery for no reason, since
the existing one already accepts arbitrary PostHog event shapes matching
`posthogEventSchema` (`posthog.ts:4-11`: `uuid?, event, distinct_id, timestamp?,
properties?, url?`) and `posthogPersonSchema` (`posthog.ts:13-23`).

### D2 — Identity: today's path uses `distinct_id` as `userId` directly, NOT the PRD-00
mapped-alias resolver — this is an existing behavior, not something this PRD introduces

**Verified**: `posthog.ts:47` — `const userId = payload.event.distinct_id;` — the raw
PostHog `distinct_id` is passed straight into `IngestEvent.userId`
(`ingestion.ts:51`), which `resolveOrCreateContact` treats as an `external` `Kind` key
(`contacts.ts:614`: `if (userId) keys.push({ kind: "external", value: userId });`). This
means the EXISTING PostHog webhook path (surveys or any other event) resolves identity
by treating `distinct_id` as if it were Hogsend's own `externalId` — it does **not** go
through the PRD-00 `resolvePostHogPerson`/mapped-alias path at all.

**This is a real tension worth naming, not silently inheriting:**

- If the operator's app calls `posthog.identify(hogsendUserId)` (i.e. their PostHog
  `distinct_id` for a logged-in user IS the same string as their Hogsend `externalId` —
  a common, encouraged integration pattern), this "just works" today and will continue to
  just work for survey events with zero PRD-08 code.
- If PostHog's `distinct_id` for the survey respondent is instead a PostHog-generated
  anonymous/device id that does NOT match any Hogsend `externalId` — which is common for
  a survey shown to a not-yet-identified visitor, or whenever the app's `distinct_id`
  scheme diverges from its Hogsend `externalId` scheme — **the existing transform mints
  or resolves against a Hogsend contact keyed by that PostHog-only string as an
  `external` key**, which is a DIFFERENT contact than the one the PRD-00 mapped-alias
  resolver would find via the person's full distinct_id set + email. This is not a new
  bug this PRD introduces (it's the standing behavior of the shipped `posthogSource`
  for every event type, not just surveys) — but it is directly relevant here because a
  survey response often carries the respondent's `email` in `person.properties.email`
  (`posthog.ts:17-23`, already read into `contactProperties`), which is exactly the signal
  PRD-00's resolver is built to reconcile against.

**Chosen handling** [PROPOSED]: this PRD does NOT change `posthog.ts`'s default identity
behavior for non-survey events (out of scope, and changing shared webhook-source identity
resolution has a much larger blast radius than this PRD's stated boundary). For survey
response events SPECIFICALLY, add an opt-in identity-reconciliation step: when the
transformed event's name matches the survey-response pattern (D3) AND `person.properties`
carries an email that does not match an EXISTING contact already keyed by this
`distinct_id`, route identity resolution through PRD-00's `resolvePostHogPerson` instead
of the bare `distinct_id`-as-`externalId` shortcut, so a survey answered by a
not-yet-identified visitor whose email IS known to PostHog reconciles to the SAME contact
their other channel activity already uses, rather than minting a `distinct_id`-keyed
duplicate. This is additive and scoped to survey events only — it does not touch the
transform's behavior for any other PostHog event, and does not retrofit PRD-00 resolution
onto the general `posthogSource` path (that would be a much bigger, unrequested change).

### D3 — Detecting a "survey response" event and normalizing the NPS-detractor shape

**[PROPOSED, and this is where the "external knowledge" flag in the Goal section matters
most]**: without a verified real PostHog survey payload, this PRD proposes recognizing
survey events by `eventProperties.$survey_id` being present (the one property
[EXTERNAL KNOWLEDGE] every PostHog survey event — shown, sent, dismissed — is expected to
carry), and normalizing the response value into a single, journey-author-friendly
property name (e.g. `surveyResponse`) regardless of whether PostHog's own wire shape uses
`$survey_response` or an indexed `$survey_response_<n>` variant for multi-question
surveys. **This normalization step is a `transform`-level addition to (or a wrapper
around) the existing `posthog.ts` transform** — it does not require a new webhook source,
consistent with D1.

An "NPS detractor" journey trigger is then authorable as an ordinary
`trigger.where`-gated event trigger — no new sugar needed, unlike PRD 04's cohort case,
because this is a plain property-on-event condition, which `JourneyWhereBuilder`
(`packages/core/src/types/journey.ts:12`) already supports natively:

```ts
trigger: {
  event: "survey sent",                       // or whatever the normalized event name is
  where: (b) => b.prop("surveyResponse").lte(6),   // NPS 0-6 = detractor
}
```

This is the SAME pattern CLAUDE.md already documents for journey enrollment guards
(`(b) => b.prop("score").lte(6)`) — no new mechanism, just a normalized property to point
it at.

## Acceptance criteria (EARS)

1. WHEN a PostHog webhook destination forwards a survey response event to the existing
   `POST /v1/webhooks/posthog` route, the system SHALL ingest it through the SAME
   transform path as any other PostHog event, with NO new route or webhook source
   required.
2. WHEN the ingested event carries `$survey_id` (or whatever the verified real property
   turns out to be — see Seams), the system SHALL normalize its response value into a
   single, stable property name journeys can trigger on regardless of single- vs.
   multi-question survey shape.
3. WHEN a journey is authored with a plain `trigger.where` property condition against the
   normalized survey-response property (e.g. `<= 6` for NPS detractor), the system SHALL
   enroll exactly as any other property-gated event trigger does — no new authoring
   primitive beyond the existing `JourneyWhereBuilder`.
4. WHEN a survey respondent's `distinct_id` does not resolve to an existing contact but
   `person.properties.email` does match one via the PRD-00 resolver, the system SHALL
   reconcile the response to that contact rather than minting a `distinct_id`-keyed
   duplicate — scoped to survey events only, per D2.
5. WHEN no PostHog credential/webhook secret is configured
   (`POSTHOG_WEBHOOK_SECRET`/`auth.envKey`, `posthog.ts:39-43`), survey ingestion SHALL be
   an inert no-op exactly as the existing webhook source already is (unauthenticated
   requests are rejected by the existing `auth: { type: "match" }` mechanism — no new
   behavior needed here).
6. WHEN feature-flag-based targeting is discussed in this PRD's scope by a future reader,
   the system SHALL NOT implement it — explicitly cut, DECISIONS §3 non-goal 2.

## Tasks

### T08.0 — Verify the claim against a real PostHog project
_Boundary:_ investigation, no production code (human-verification seam, see Seams) ·
_Depends:_ —

Confirm, against a real PostHog project with an active survey and a configured webhook
destination (or Workflow) pointed at a test `POST /v1/webhooks/posthog` endpoint, that:
(a) survey response events actually arrive at this route with no additional PostHog-side
configuration beyond a normal event webhook destination, (b) the exact property names
PostHog uses for survey id and response value (confirm or correct the `$survey_id`/
`$survey_response[_n]` assumption in D3), and (c) whether `person.properties.email` is
reliably present on a survey response for an identified user. **This task's findings
gate T08.2** — do not hand-wave the property names in code before this is confirmed.

### T08.1 — Confirm identity-reconciliation gap is real and scope it
_Boundary:_ investigation · _Depends:_ T08.0

Using the real payload from T08.0, confirm whether `distinct_id` for a genuine survey
respondent commonly diverges from any Hogsend `externalId` in practice (vs. this being a
theoretical concern only relevant to not-yet-identified visitors). This determines
whether D2's opt-in reconciliation (T08.3) is worth building now or should be deferred
until PRD 00 and PRD 08 both have real usage data.

### T08.2 — Survey-response normalization
_Boundary:_ `apps/api/src/webhook-sources/posthog.ts` (consumer-owned, per CLAUDE.md's
webhook-source system — this is NOT engine code) · _Depends:_ T08.0

Add the `$survey_id`-detection + response-value normalization from D3 to the existing
`transform`, using the property names T08.0 confirmed. Keep the change additive: every
non-survey event's transform output must be byte-identical to today's behavior (mutation-
test this — a test that would pass even if the additive branch accidentally changed
non-survey behavior is vacuous).

### T08.3 — Opt-in identity reconciliation for survey events
_Boundary:_ `apps/api/src/webhook-sources/posthog.ts` + `packages/engine/src/lib/`
(consumes PRD 00's `resolvePostHogPerson`) · _Depends:_ T08.1, PRD 00 T00.3

Only if T08.1 confirms the gap is real and worth closing now: route survey-event identity
through `resolvePostHogPerson` when `distinct_id` doesn't resolve but email does,
per D2. If T08.1 finds this is not a practical concern yet, mark this task deferred
rather than building speculative reconciliation logic against no evidence.

## Seams

- **T08.0 cannot be completed by reading code alone** — it requires a real PostHog
  project with an active survey and a webhook destination, which is exactly the kind of
  human-verification seam this stack's other PRDs already flag (DECISIONS §7). Until
  T08.0 runs, D3's property names are an assumption, clearly marked as such throughout
  this PRD, not a verified fact.
- T08.1's finding may retarget T08.3's priority relative to the rest of this stack; do not
  block T08.2 (the normalization, which is useful regardless) on T08.3's outcome.

## Done when

T08.0's findings are recorded in Implementation Notes (confirmed or corrected property
names, confirmed or refuted "arrives with zero config" claim), T08.2 ships with the
confirmed property names and a passing non-regression test proving non-survey event
transform output is unchanged, and — if T08.1 justifies it — T08.3 ships with a test
demonstrating a survey response from an unresolved `distinct_id` with a matching email
reconciles to the existing contact rather than minting a duplicate.

## Implementation Notes
