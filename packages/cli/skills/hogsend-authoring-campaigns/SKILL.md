---
name: hogsend-authoring-campaigns
description: Use when adding or editing a one-shot campaign (broadcast) in src/campaigns/ — defineCampaign({ id, audience: { list } | { bucket }, template, props?, subject?, from?, sendAt, enabled? }) from @hogsend/engine, a scheduled blast committed to the repo. Covers the boot reconciler (future sendAt schedules; edits sync while still scheduled; a stale sendAt at first deploy expires instead of firing; sent = retired), the register ritual (src/campaigns/index.ts + thread campaigns into createHogsendClient in BOTH src/index.ts and src/worker.ts), cancel via CLI/Studio/API, and when to use the API (hs.campaigns.send) instead of a definition.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend campaigns (broadcasts)

A **campaign** is a one-time broadcast: one template sent to a whole audience —
every subscribed member of a list, or every active member of a bucket. Unlike a
journey it has no trigger and no control flow; it fires once at a scheduled
instant and is then **retired**.

`defineCampaign()` commits that broadcast to the repo, mirroring
`defineJourney()` / `defineList()`: write a file, deploy, and the worker's boot
reconciler schedules it. Git history is your campaign history.

You are editing a **scaffolded consumer app** (content only). You import
`defineCampaign` from `@hogsend/engine`; the row lifecycle, durable send task,
scheduling, and cancel machinery are all engine-owned.

## The shape

```ts
import { defineCampaign } from "@hogsend/engine";

export const julyLaunch = defineCampaign({
  id: "july-2026-launch",            // stable slug — the retirement key
  name: "July launch announcement",  // optional, defaults to id
  audience: { list: "product-updates" }, // or { bucket: "power-users" }
  template: "marketing/product-update",  // type-checked against your registry
  props: { headline: "It shipped." },
  subject: "Optional subject override",
  from: "Optional from override <team@example.com>",
  sendAt: "2026-07-15T16:00:00Z",    // ISO string or Date
  // enabled: true,                  // optional; false = reconciler ignores it
});
```

Validated at definition time (throws): `id` matches `/^[a-z0-9_-]+$/i`, the
audience is EXACTLY one of `list` | `bucket`, and `sendAt` parses. Whether
`sendAt` is still in the future is a deploy-time question the reconciler
answers (below). The audience id and template key are validated against the
registries at worker boot — a broken definition is skipped with an error log,
never a worker crash.

## Register ritual

1. Create the file in `src/campaigns/`.
2. Export it from `src/campaigns/index.ts` and add it to the `campaigns` array.
3. The array is threaded into `createHogsendClient({ campaigns })` in BOTH
   `src/index.ts` and `src/worker.ts` (already wired in the scaffold). The
   worker reconciles at boot; `createWorker` needs no `campaigns` of its own
   (it defaults to the container's).

## What the boot reconciler does

Each definition upserts a `campaigns` row keyed `campaign-def:<id>`:

| At reconcile | Outcome |
|---|---|
| No row yet, `sendAt` in the future | Created `scheduled`, delivered at that instant |
| No row yet, `sendAt` past-due but within the grace window (default 1h, `CAMPAIGN_DEFINE_GRACE_MS`) | Enqueued on boot — a deploy that lands minutes late still sends |
| No row yet, `sendAt` staler than the grace window | Created `expired`, warning logged — a file committed with last week's date can NEVER blast on deploy |
| Row still `scheduled`, file edited | name/audience/template/props/subject/from/sendAt synced; a moved `sendAt` re-schedules |
| Row `sent` | No-op — retired. Redeploys never re-send; deleting the file keeps the history row |
| Row `canceled` | No-op — an operator cancel is never resurrected by a redeploy |

The audience is resolved **at send time** — contacts who join the list/bucket
after the send do not receive it. Suppressed and globally-unsubscribed contacts
are excluded (audience resolution AND per-send check); a list audience follows
the list's `defaultOptIn` polarity.

## Cancel, inspect

```bash
hogsend campaigns list --status scheduled
hogsend campaigns cancel <campaignId>     # until (or during) the send
hogsend campaigns status <campaignId>     # counts: sent/skipped/failed
```

Studio has a Campaigns view with the same list + cancel. A mid-send cancel
stops at the next chunk of 100 — undispatched recipients are spared;
already-sent emails are not recalled.

Statuses: `scheduled → sending → sent` (immediate sends start at `queued`),
plus `failed` (reaper gave up; re-runnable), `canceled`, `expired` (terminal).

## Definition vs. API call

- **`defineCampaign()`** — the broadcast is content: reviewed in a PR, scheduled
  by deploy, retired by the reconciler. Best for announcements you plan.
- **`hs.campaigns.send({ list, template, props, sendAt?, idempotencyKey })`**
  (`POST /v1/campaigns`) — the broadcast is triggered by your product code or
  an operator at run time. Same engine path (durable task, per-recipient
  idempotency `campaign:<id>:<email>`, preference checks, tracking); pass
  `idempotencyKey` so a retried create never double-blasts.

## Gotchas

- The `id` is the retirement key. Renaming it mints a NEW campaign — the old
  row stays, the new one schedules. Rename only if that is what you mean.
- Edits after the send are silently ignored (the row left `scheduled`). Want a
  follow-up blast? New file, new id.
- Ship examples `enabled: false` (the scaffold's are). The reconciler skips
  disabled definitions entirely.
- `sendAt` is an instant, not a local wall time — use an explicit offset
  (`2026-07-15T16:00:00Z` or `…+02:00`).
