# Query metrics, contacts, and events

Read-only analysis over a running Hogsend instance. Always pass `--json` when
parsing.

## Overview metrics

```bash
hogsend stats --json
```

Wraps `GET /v1/admin/metrics/overview`. Returns (shape may vary slightly by
version):

```json
{
  "totalContacts": 1234,
  "activeJourneys": 5,
  "emailsSent24h": 88,
  "emailsSent7d": 540,
  "emailsSent30d": 2100,
  "bounceRate30d": 0.012,
  "unsubscribeRate": 0.004
}
```

Use this for a one-shot snapshot. `bounceRate30d` / `unsubscribeRate` are
fractions (multiply by 100 for a percentage). A rising bounce rate is the first
signal of a deliverability problem.

## Contacts

```bash
# List with search + pagination
hogsend contacts list --search "@acme.com" --limit 50 --offset 0 --json

# A single contact by internal id OR externalId
hogsend contacts get user_123 --json

# Merged activity timeline (events + emails + journeys) for one contact
hogsend contacts timeline user_123 --json
```

Wraps `GET /v1/admin/contacts`, `GET /v1/admin/contacts/{id}`, and
`GET /v1/admin/contacts/{id}/timeline`. `get` includes the contact record plus
email preferences (subscribed / unsubscribed). The timeline is the fastest way
to understand a single user's lifecycle history.

## Raw event stream

```bash
hogsend events user_123 --json
hogsend events user_123 --event "checkout.completed" --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --limit 100 --json
```

Wraps `GET /v1/admin/events?userId=<userId>`. Filter by `--event`, time window
(`--from`/`--to`, ISO 8601), and paginate with `--limit`/`--offset`. Use this
when the timeline isn't granular enough and you need the exact event payloads
(e.g. to see which properties were present when a journey trigger fired).

## Analysis pattern

1. `hogsend stats --json` for the macro picture.
2. `hogsend contacts list --search ... --json` to find the cohort.
3. `hogsend contacts timeline <id> --json` to understand individual journeys.
4. `hogsend events <id> --event <name> --json` to inspect exact payloads.
