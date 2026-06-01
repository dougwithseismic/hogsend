# Debug a journey: why did (or didn't) a user enroll?

A repeatable trace using `doctor` + `journeys get` + `contacts timeline` +
`events`. Run every command with `--json` and read the output.

## Step 0 — confirm the instance is healthy

```bash
hogsend doctor --json
```

Wraps `GET /v1/health`. Inspect the verdict:

- `ok` — healthy, proceed.
- `degraded` — a component (database / redis) is unhealthy; reads may be
  unreliable. Exit code 1.
- `migration_pending` — the engine schema and the client schema are out of
  sync (`schema.inSync = false`, `pending` migrations listed). Data may be
  missing columns; fix the drift before trusting other queries.
- `unreachable` — could not connect (HTTP status 0). Check `--url` and that the
  app is running. Exit code 1.

Do NOT trust downstream reads until doctor returns `ok`.

## Step 1 — understand the journey's entry rules

```bash
hogsend journeys get <journeyId> --json
```

Read the `trigger` (which event enrolls a user) and any `trigger.where`
property conditions. Read `exitOn` rules (what removes a user). Enrollment is
gated, in order, by: `enabled` flag → trigger `where` conditions → entry limit
(once / once_per_period / unlimited) → email preferences (unsubscribed users
are skipped). Any failed gate means NO enrollment.

## Step 2 — look at the user's lifecycle

```bash
hogsend contacts get <userId> --json        # subscribed? unsubscribed?
hogsend contacts timeline <userId> --json    # merged events/emails/journeys
```

The timeline shows whether the user already has an active/completed state for
this journey (entry limit may have blocked re-entry) and whether they're
unsubscribed (which skips email-sending journeys).

## Step 3 — verify the trigger event actually fired with the right props

```bash
hogsend events <userId> --event <triggerEvent> --json
```

Wraps `GET /v1/admin/events?userId=<userId>`. Confirm the trigger event exists
for this user AND that its properties satisfy the journey's `trigger.where`
conditions. A missing event, or an event whose properties fail the `where`
check, is the most common reason a user did not enroll.

## Decision tree

- No trigger event in `events` → upstream isn't sending it (PostHog / webhook).
- Trigger event present but `where` mismatch → property condition not met.
- Already has a journey state → entry limit blocked re-enrollment.
- Contact unsubscribed → email journeys skipped at the preferences gate.
- Journey `enabled: false` (from `journeys get`) → no enrollment at all.
- `doctor` not `ok` → fix infra/schema first; the data is suspect.
