# Multi-step, multi-channel campaigns (waves) — design spec

Status: **approved direction, not yet built**. Phases 1–3 are the commitment;
phase 4 is sketched so the shapes don't corner us.

Companion doc: **`docs/audience-model.md`** — what contacts, lists, buckets,
and audiences are and where they're defined. This spec assumes those nouns.

## Problem

A campaign today is a one-shot email broadcast: one template, one audience,
one instant. Two real needs don't fit:

- **Multi-step** — "send the announcement, wait two days, remind the
  non-openers." No way to express it, and the two obvious escape routes are
  both wrong: growing the blast loop into an ad-hoc workflow engine
  (duplicates journey primitives), or enrolling every recipient into a journey
  (one durable Hatchet run per recipient — 50k–100k runs, most sleeping, on
  self-hosted Hatchet-Lite; rejected as the default mechanism).
- **Multi-channel** — a launch campaign is not only email. "Post in the
  Discord server that invites are going out, then email everyone on the
  waitlist" is one campaign, defined in one file, in code.

## Design principle: one concept, two runtimes

> **A journey runs code per person. A campaign runs waves per audience.**

Campaign steps are **data**, executed as **waves**: each step is a set
operation over the audience (resolve qualifiers by SQL → chunked delivery),
separated by durable waits. A 3-step campaign to 100k people costs **~3
durable runs**, not 100k. Branch conditions are engagement facts we already
have first-party (`email_sends.openedAt/clickedAt`, `link_clicks`,
`user_events` — including the connector engagement events).

Coherence with journeys comes from shared vocabulary, not a shared runtime:
`defineCampaign` sits next to `defineJourney`, uses the same `Templates` and
`Events` constants, `days()/hours()` duration helpers, builder-style `where`,
the same reconciler git-ops loop, and the same Studio surface conventions.
When a campaign genuinely needs per-user logic, the answer is a journey
(phase 4 handoff), never a per-user campaign runtime.

Cost model (100k-recipient list, 3-step campaign):

| Runtime | Durable runs | Provider calls |
|---|---|---|
| Waves (this spec) | ~3 (+~24–40 with local-time delivery) | same either way |
| Per-recipient journeys | 100k+ (most sleeping for days) | same either way |

## Audience model

Read **`docs/audience-model.md`** first — it defines the four nouns (contact,
list, bucket, audience), where each is authored, and how each resolves to
recipients. The campaign-specific consequences:

- `audience:` is exactly one of `{ list: id }` or `{ bucket: id }` — a
  pointer, resolved live at the first per-recipient wave.
- **A bucket campaign borrows consent from its template's declared category**
  (a bucket is behavior, not consent); a list campaign passes the list id
  itself as the send category. The reconciler warns on a bucket campaign
  whose template has no category.
- **Cohort anchoring vs live buckets:** a member who leaves the bucket
  between waves still receives later steps (suppression is always
  re-checked). If a step must require *current* membership, that is a future
  `c.inBucket()` condition — a named seam (`check-membership.ts` exists),
  not built in v1.
- A waitlist is an **opt-in list**, not a bucket — signing up is the consent
  (the decision rule lives in the audience-model doc).

## Authoring surface

The headline example — a waitlist launch, one file, code-defined:

```ts
import { defineCampaign, step } from "@hogsend/engine";
import { days } from "@hogsend/core";
import { Templates, Events } from "../journeys/constants/index.js";
import { DISCORD } from "../constants/discord.js";

export default defineCampaign({
  id: "waitlist-launch",
  name: "Waitlist launch day",
  audience: { list: "waitlist" },
  sendAt: "2026-08-01T16:00:00Z",
  steps: [
    // Announcement: ONE post to the guild channel — not per-recipient.
    step.discord.post({
      channelId: DISCORD.ANNOUNCEMENTS,
      message: "Invites are going out now — check the inbox you signed up with.",
    }),
    // Per-recipient wave over the audience.
    step.send({ template: Templates.WAITLIST_INVITE }),
    step.wait(days(3)),
    step.send({
      template: Templates.WAITLIST_INVITE_REMINDER,
      where: (c) => [c.notFiredEvent(Events.ACCOUNT_CREATED), c.notClicked()],
    }),
  ],
});
```

- The existing single-template form (`template`/`props`/`subject`/`from` at the
  top level) stays supported forever and compiles to `steps: [step.send(…)]`
  internally. Existing definitions and the `POST /v1/campaigns` data-plane are
  untouched.
- `step.send({ template, props?, subject?, from?, where? })` — an email wave.
- `step.wait(duration)` — durable gap between waves.
- Channel steps — see [Channels](#channels-phase-2) below.
- `where` receives a cohort builder and returns one condition or an array
  (array = AND; OR is deferred — core's `composite` condition type is the
  ready seam). Builders normalize to core `Condition` data at `defineCampaign`
  time (same normalize-at-definition pattern as `trigger.where` in
  `defineJourney`), so the stored form is plain data.

### Step taxonomy

Every step is one of three kinds; the distinction is load-bearing:

| Kind | Cardinality | Ledger | `where` allowed |
|---|---|---|---|
| **Per-recipient** (`step.send`, `step.discord.dm`, `step.telegram.dm`, future `step.notify`) | one delivery per qualifying cohort member | `email_sends` / `connector_deliveries` / `feed_items` | yes (after the cohort exists) |
| **Announcement** (`step.discord.post`, future channel posts) | exactly one delivery, to a place not a person | one `connector_deliveries` row | no (nothing per-recipient to filter) |
| **Wait** (`step.wait`) | none | none | — |

### Cohort builder vocabulary (v1 — deliberately small)

| Builder | Meaning (scoped to THIS campaign's prior deliveries) |
|---|---|
| `c.opened(template?)` / `c.notOpened(template?)` | `email_sends.openedAt` set / null on a prior wave's send |
| `c.clicked(template?)` / `c.notClicked(template?)` | same on `clickedAt` |
| `c.firedEvent(event)` / `c.notFiredEvent(event)` | a `user_events` row for this user since the campaign's `startedAt` |
| `c.linked(connector)` / `c.notLinked(connector)` | the member has / lacks a linked identity for that connector (`contact_aliases` kind, e.g. `discord_id`) — the channel-fallback condition |

Most compile to existing core condition types (`email_engagement`, `event`);
`linked` is one new condition type (`channel_identity`) — a single EXISTS on
`contact_aliases`.
Bulk evaluation is new SQL in the engine (EXISTS / NOT EXISTS subqueries per
page, mirroring the suppression pre-filters in `send-campaign.ts`) — the
per-user `evaluateCondition()` path is not used on the wave hot path.
`c.firedEvent` already covers connector engagement (Discord/Telegram
engagement events land as `user_events`); channel-specific sugar can come
later without a shape change.

### Validation (at `defineCampaign`, throw loudly)

- `steps` non-empty; **first step is a per-recipient send or an announcement**
  (`sendAt` is the timing — a leading wait is redundant); **no trailing
  wait**; max 10 steps.
- `where` only on per-recipient steps that come after the first per-recipient
  step (the cohort must exist before it can be filtered).
- Every email step's template must exist in the registry; every channel
  step's connector action must exist in the connector registry (reconciler
  re-checks both against the wired registries, same as today's single
  template check).
- Waits shorter than 5 minutes rejected (below the scheduling grace windows).

## Data model

`campaigns` row gains (one engine-track migration):

- `steps` jsonb — `{ v: 1, steps: [...] }` (versioned blob; `v` is the
  forward-evolution seam for A/B splits etc.). NULL = legacy single-send row.
- `currentStep` integer default 0 — the next step to execute.
- `nextStepAt` timestamptz — when the pending wait elapses. The reaper's
  promote/give-up sweeps key off it (mirror of `scheduledAt`).

New status: **`waiting`** — between waves. Non-terminal, cancelable, and
crucially NOT subject to the stale-`sending` re-enqueue sweep (a 2-day wait is
not a stuck campaign). The status column is already plain text by design — no
migration needed for the value itself.

### `campaign_recipients` — the channel-neutral cohort ledger

New table, written once per campaign at the **first per-recipient wave**
(batch-inserted per pagination chunk, idempotent via a unique
`(campaign_id, email)` — column layout leaves room for channel-native
identities later: nullable email + identity kind/value):

- `campaign_id`, `user_id`, `email` (normalized), `resolved_at`.

Why a table (and not deriving the cohort from `email_sends` LIKE-attribution):
the cohort concept is **channel-neutral** — a campaign whose step 1 is email
and step 2 is a Discord DM needs one membership source that both waves project
from. Per-channel delivery tables stay what they are (delivery + engagement
ledgers, stats attribution); membership lives here. It also makes every wave-k
qualifier query an indexed join instead of a LIKE scan.

### Per-delivery idempotency keys (step-scoped)

- **Single-step campaigns keep the legacy key** `campaign:<id>:<email>` —
  behavior, stats queries, and any in-flight campaign at deploy time are
  unchanged.
- **Multi-step campaigns use `campaign:<id>:<step>:<email>` for ALL steps
  including 0.** No ambiguity with the legacy format is possible (multi-step
  campaigns don't exist before this ships), and the campaign-level stats
  pattern `campaign:<id>:%` remains a correct superset of both. Per-step stats
  filter on `campaign:<id>:<k>:%`.
- **Announcement steps** use `campaign:<id>:<step>:@announce` — one ledger
  row, so a wave retry no-ops the post.
- The key deliberately does NOT include a timezone bucket (phase 3), so the
  bucketing implementation can change freely — same recipient + same step =
  same key, always.

`campaignSendKey()` gains an optional step arg; `campaignSendKeyPattern()`
gains a per-step variant. Both stay the single owned home of the format.

### Hard prerequisite: connector delivery idempotency

`sendConnectorAction()` today has **no Layer-2 idempotency backstop** (the
known double-send follow-up from the replay-safety work). Campaign waves
retry by design, so this gap must close before any channel step ships:
`connector_deliveries` gains an `idempotency_key` column + partial unique
index, and `sendConnectorAction()` gains an `idempotencyKey` option that
short-circuits to the prior row — the exact contract `email_sends` +
`sendEmail()` already implement. This also retires the journey-side
double-send caveat for free.

## Wave runtime

`sendCampaignTask` keeps its name and `{ campaignId }` input; the row's
`currentStep` is the sole resume cursor. Execution:

1. **Guards** (extending the existing ones): terminal statuses unchanged;
   early-fire guard also skips a `waiting` row whose `nextStepAt` is still
   future (stale punctual run after an edit — same pattern as `scheduledAt`).
2. **Claim CAS** → `sending` from `queued | scheduled | sending | waiting`.
3. **Execute the wave for `currentStep`**:
   - *Announcement step*: one connector action with the `@announce` key.
   - *First per-recipient step*: resolve the audience live (current
     list/bucket resolvers, fresh suppression pre-filter), writing
     `campaign_recipients` rows per chunk as it delivers.
   - *Later per-recipient steps*: resolve qualifiers =
     `campaign_recipients` **∩** the step's `where` conditions **∩** a fresh
     suppression/unsubscribe NOT-EXISTS re-check, keyset-paginated.
   - Chunked delivery with step-scoped keys, per-chunk cancel check,
     progress-count flushes — all existing invariants carry over verbatim.
   - Consecutive non-wait steps run sequentially in the same task run.
4. **On reaching a wait step**: CAS `sending → waiting`, set
   `currentStep = k+1`, `nextStepAt = now + wait`, create a punctual Hatchet
   scheduled run at `nextStepAt` (best-effort; the reaper sweep is the
   backstop, same split as `scheduledAt` today).
5. **After the last step**: CAS `sending → sent`, `completedAt` — unchanged.

### Cohort semantics (the load-bearing invariants)

- **The cohort is anchored at the first per-recipient wave** — the audience is
  resolved exactly once per campaign. Someone added to the list afterwards
  never receives step 3 without step 1; the next campaign gets them.
- **Suppression is never snapshotted** — every wave re-checks
  unsubscribe/suppression at delivery time (GDPR/CAN-SPAM), so a member who
  unsubscribes between waves is excluded from every subsequent wave
  automatically.
- **Channel steps project the cohort, they don't redefine it.** A
  `step.discord.dm` delivers to cohort members with a linked `discord_id`
  alias; members without one are counted `skipped` (reason: no identity for
  channel), stay in the cohort, and receive later email steps normally.
- A member whose step-0 email failed (provider error) remains in the cohort
  and can receive later steps — a provider hiccup is not an exit.

### Failure/retry/cancel (all existing invariants extend)

- A crash mid-wave leaves the row `sending`; the retry/reaper re-enters at
  `currentStep`, already-dispatched deliveries no-op via their step-scoped
  key, and the run completes the tail before advancing. The catch block still
  never stamps `failed` (same silent-under-delivery rationale as today).
- Reaper sweep gains two mirror clauses: promote `waiting` rows whose
  `nextStepAt` is past grace (lost punctual run), and give-up `waiting` rows
  stuck past the give-up window **measured from `nextStepAt`** (a row is
  legitimately idle mid-wait, exactly like `scheduled`/`scheduledAt`).
- Cancel: the allowed set gains `waiting`. A pending step's scheduled run
  no-ops via the terminal guard when it fires — identical to how a canceled
  `scheduled` campaign's punctual run dies today.
- Reconciler: definition edits sync **only while the row is still
  `scheduled`** — the existing CAS rule, unchanged. Once a campaign is running
  or waiting, the row is the source of truth; editing steps mid-flight is
  deliberately not supported in v1.
- Channel pacing: Discord/Telegram DM sweeps are rate-limited by the
  platform. The wave loop paces per-recipient connector deliveries from the
  connector action's declared rate (seam on the action definition); a wave
  that outlives `executionTimeout` resumes via the normal retry path (keys
  make the overlap harmless).

### Counts + Studio

- Top-level counts (`totalRecipients`/`sentCount`/…) become **cumulative
  across waves** (the flush-overwrite semantics extend naturally).
- Per-step stats are **derived, not stored**: per-step key patterns over
  `email_sends` / `connector_deliveries` — the same LIKE-attribution the
  admin campaign-stats route already does at campaign level. The #381 detail
  page gains a per-step funnel row (with a channel icon per step) and a
  `waiting` status chip with a `nextStepAt` countdown.
- `GET /v1/campaigns/:id` response gains `steps` (summary), `currentStep`,
  `nextStepAt`.

## Channels (phase 2)

Channel steps are **thin wrappers over the existing connector action
registry** — no parallel channel abstraction. The stored data form is
`{ kind: "action", connector, action, params, perRecipient, where? }`; typed
sugar per connector:

- `step.discord.post({ channelId, message })` — announcement (one delivery).
- `step.discord.dm({ message })` — per-recipient over the cohort: delivers to
  every audience member (list OR bucket — cohort resolution is
  audience-kind-agnostic) with a linked `discord_id` alias (cold-connect
  machinery); unlinked members are counted `skipped` and stay in the cohort.
  Message supports the same props interpolation as connector actions today.
- `step.telegram.dm({ message })` — same shape.
- `step.action({ connector, action, params, perRecipient })` — the generic
  escape hatch for any registered connector action.
- `step.notify(…)` (in-app feed/bell) — same per-recipient shape with
  `feed_items` as the ledger; listed as a candidate, specced when wanted.

The channel-fallback pattern — DM the linked, email the rest — is two steps
with the `linked` condition, no special routing machinery:

```ts
steps: [
  step.discord.dm({ message: "Your invite is live — check your inbox." }),
  step.send({
    template: Templates.WAITLIST_INVITE_NUDGE,
    where: (c) => c.notLinked("discord"),
  }),
]
```

Deliberately deferred: **channel-native audiences** (e.g.
`audience: { discord: { guild } }` — "everyone on the server" as recipients).
The contact-anchored model stays: guild members become contacts via
cold-connect, land in lists, and campaigns address lists. The audience-kind
column is a string, so the seam is open if a real need appears.

## Phase 3 — local-time delivery (tz-bucketed waves)

"Hit each user at 9am *their* time" without per-user runs: **bucket the wave
by timezone**, one sub-wave per distinct IANA zone → instant.

- Field shapes (reserved now, built in phase 3):
  - `sendAt: { date: "2026-08-01", localTime: "09:00" }` — wave 0 lands at
    9am local per recipient.
  - `step.wait(days(2), { alignTo: "09:00" })` — wait, then align to the next
    9am local.
- Timezone source, in order: `contacts.timezone` (the IANA cache already on
  the schema, populated best-effort from PostHog) → client default → UTC.
  **No per-recipient PostHog lookups on the wave path** — bulk means
  DB-resident data only. An optional pre-sweep enrichment task can warm the
  cache later.
- Runtime: resolve qualifiers → group by zone → compute each zone's instant
  via the core `schedule/` Temporal machinery (`atTime`, DST-safe) → dedupe
  zones sharing an instant → one scheduled run per distinct instant (input
  `{ campaignId, waveInstant }`), tracked in a small jsonb ledger on the row;
  the sub-wave completing the ledger advances the step. Worst case is ~24–40
  sub-waves per step — O(zones), never O(recipients).
- Because delivery keys exclude the bucket, a recipient double-assigned
  across buckets (tz cache changed mid-wave) is harmless — the second
  delivery no-ops.

## Phase 4 — sketched, not committed

- **`step.trigger({ event, props? })`** — the journey handoff: emit a
  per-recipient event through the ingest pipeline (idempotent via the existing
  `user_events` dedup), enrolling qualifiers into any journey listening on
  that trigger. This IS one durable run per matched recipient — the docs say
  so loudly, and it's for carved-down segments ("the 800 who clicked"), never
  the full list. It is the full-power escape hatch that keeps per-user logic
  in journeys where it belongs.
- **API/Studio multi-step creation** — `steps` is plain data, so
  `POST /v1/campaigns` can accept it later with the same validation; deferred
  to keep the early blast radius small (code-defined first, matching how
  lists and journeys landed).
- **Recurring sweeps** — the wave primitive ("scheduled audience resolution →
  set-filtered deliveries") is the stepping stone to digests/re-engagement
  (the Knock/Novu gap). Nothing in this spec blocks a future `repeat:` field;
  nothing builds it now.

## Non-goals

- No per-user `run()` on campaigns — that's `defineJourney`.
- No visual campaign builder — Studio stays observe-not-author.
- No mass-DM of non-contacts. DMing linked audience members IS core
  (phase 2); what's deferred is treating a raw guild roster as an audience —
  cold-connect is the bridge that turns members into contacts first.
- No A/B splits, no OR conditions, no mid-flight step editing in v1 (each has
  a named seam: `steps.v`, `composite` conditions, the `scheduled`-only CAS).

## Sizing

- **Phase 1 (email waves)** — M: step types + builder + validation
  (core/engine), `campaign_recipients` + wave execution + `waiting` state +
  reaper clauses (engine), per-step stats route + Studio funnel rows, tests
  for the cohort/retry/cancel invariants.
- **Phase 2 (channel steps)** — M: connector-delivery idempotency
  (prerequisite, also fixes the journey double-send caveat), announcement +
  per-recipient action steps, identity projection + skip accounting, pacing
  seam.
- **Phase 3 (local time)** — S/M: bucketing + ledger + `alignTo` resolution
  on top of existing schedule machinery.
- **Phase 4** — S each, when wanted.
