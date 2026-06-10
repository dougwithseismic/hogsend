# Cutover checklist — dual-write → verify → switch → remove

The execution playbook. Work flow-by-flow, never big-bang. Keys: data-plane
writes use the ingest key (`HOGSEND_API_KEY`); admin reads/writes use an admin
key (`HOGSEND_ADMIN_KEY` / `ADMIN_API_KEY`). `--json` on every CLI call you
parse.

## Stage 0 — imports (BEFORE anything sends)

### 0a. Contacts

Bulk path — the admin import endpoint (admin key):

```
POST /v1/admin/contacts/import
{ "format": "csv" | "json", "data": "<file contents>", "fileName?": "..." }
→ 202 { jobId, status }
GET /v1/admin/contacts/import/{jobId}   → processed/failed counts + errors
```

Rows carry `externalId?`, `email?`, `properties?` (CSV: those columns; at least
one identity per row). **The bulk import does NOT carry list membership or
unsubscribe state** — handle those in 0b/0c.

Scripted alternative (and the way to set list membership in the same pass):
loop the export through the SDK —

```ts
for (const row of exported) {
  await hogsend.contacts.upsert({
    email: row.email,
    userId: row.externalId,
    properties: row.properties,
    lists: { newsletter: row.subscribedToNewsletter === true },
  });
}
```

`contacts.upsert` is a true upsert — re-running the loop is safe.

### 0b. List membership

Either inline via `lists` on the upsert (above), or per-list:

```ts
await hogsend.lists.subscribe({ list: "newsletter", email: row.email });
```

Mind polarity: for an opt-in list (`defaultOptIn: false`) you only need to
subscribe the members; for an opt-out list you only need to record the
unsubscribes.

### 0c. Suppression / unsubscribes (THE critical import)

- **List-level unsubscribes** →
  `hogsend.lists.unsubscribe({ list, email })` per contact+list.
- **Global unsubscribes** ("never email this person") → the admin preferences
  route, per contact (UUID or externalId both work as `{contactId}`):

```
PUT /v1/admin/contacts/{contactId}/preferences
{ "unsubscribedAll": true }
```

(`suppressed: true` is also accepted there — use it for hard-bounced/complained
addresses from the source platform's suppression export.)

**Gate: do not proceed to any send until a spot check passes** — pick 3 known
unsubscribed addresses, confirm via
`hogsend contacts get <id> --json` / the preferences route that they show
`unsubscribedAll: true`, and confirm a test `hogsend emails send` to one of
them is refused by the preference check.

## Stage 1 — dual-write

- Add `@hogsend/client` calls BESIDE the existing SDK calls (same handlers,
  both fire). Use `idempotencyKey` on webhook-driven events.
- Author journeys/templates/lists in the Hogsend app, but keep journeys OFF:
  `enabled: false` in meta, or excluded from the `ENABLED_JOURNEYS` env
  (comma-separated ids; `*` = all).
- Keep the source platform fully live. Nothing user-visible changes.

## Stage 2 — verify (run a few days)

```bash
hogsend doctor --json                 # instance healthy
hogsend stats --json                  # totalContacts matches the import
hogsend events <userId> --json        # spot-check: events arriving for real users
hogsend contacts timeline <id> --json # merged activity view for a known user
```

- **Volume:** compare daily event counts per event name against the source
  platform's numbers. Investigate gaps > a few percent.
- **Journeys:** enroll a seed contact (your own address):
  `hogsend events send signup --email you@yourco.com --json`, temporarily
  enable the journey (`hogsend journeys enable <id>`), walk the full flow —
  delays, branches, sends — then disable again if the soak isn't done.
- **Templates:** send each to yourself
  (`hogsend emails send <template> --to you@yourco.com --prop key=value`) and
  diff against the source platform's rendering. Check the unsubscribe link
  resolves.

## Stage 3 — switch (per flow, old OFF in the same window)

For each lifecycle flow, in one change window:

1. Enable the Hogsend journey — `hogsend journeys enable <id> --json` (or ship
   `enabled: true` / add to `ENABLED_JOURNEYS` and deploy).
2. Pause the corresponding workflow/campaign in the source platform's
   dashboard.
3. Watch the first real enrollments: `hogsend journeys get <id> --json`
   (state counts + recent states).

For transactional: flip each call site from the old SDK to `hs.emails.send`
(delete the old call, don't dual-send transactional — a user must never get
two password resets). For broadcasts: run the next one as a Hogsend campaign
(`hogsend campaigns send --list … --template …`; progress via
`hogsend campaigns status <id> --json`).

## Stage 4 — remove

After 1-2 clean send cycles:

- Delete the old SDK calls and the dep (`pnpm remove <pkg>`); remove its env
  vars from every environment.
- Revoke the source platform's API keys.
- Export final archives (campaign history, analytics) — they don't migrate.
- Re-export the source's suppression list ONE more time and re-run 0c — people
  unsubscribed during the dual-write window must not be lost.
- Close/downgrade the account.

## Rollback

Until Stage 4, rollback is cheap and symmetrical: disable the Hogsend journey
(`hogsend journeys disable <id>`), resume the source workflow. That symmetry is
the reason for flow-by-flow switching — keep it until you delete the old code.
