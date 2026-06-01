# Manage journeys

Inspect and toggle lifecycle journeys on a running Hogsend instance. `list` and
`get` are read-only; `enable`/`disable` are writes.

## List

```bash
hogsend journeys list --json
hogsend journeys list --enabled true --limit 50 --offset 0 --json
```

Wraps `GET /v1/admin/journeys`. Filter with `--enabled <true|false>`, paginate
with `--limit`/`--offset`. Each row carries `id`, `name`, `enabled`, the
trigger event, and enrollment counts (active / completed / failed). Use the
`id` for every other journey command.

## Get detail

```bash
hogsend journeys get conversion-trial-upgrade --json
```

Wraps `GET /v1/admin/journeys/{id}`. Returns the full definition view —
trigger (event + optional `where` conditions), `exitOn` rules, aggregate
counts, and a sample of recent `journeyStates` (so you can see who is currently
active / waiting / completed). This is your starting point before toggling a
journey.

## Enable / disable

```bash
hogsend journeys enable conversion-trial-upgrade --json
hogsend journeys disable conversion-trial-upgrade --json
```

Wraps `PATCH /v1/admin/journeys/{id}` with `{ "enabled": true|false }`.

Safety notes:

- These are WRITES against a live system. Confirm the journey `id` with
  `journeys get` first, and confirm intent with the human before disabling a
  journey that has active enrollments.
- Disabling stops NEW enrollments. Contacts already mid-journey continue per
  the engine's semantics — disabling is not a kill switch for in-flight states.
- After toggling, re-run `journeys get <id> --json` and confirm `enabled`
  flipped as expected.

## Counts cheatsheet

When reading counts: `active` = currently enrolled (may be sleeping/waiting),
`completed` = finished the run, `failed` = errored. A journey with rising
`failed` counts is worth a `debug-a-journey` pass.
