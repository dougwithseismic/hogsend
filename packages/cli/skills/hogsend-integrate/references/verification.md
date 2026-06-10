# Verification — prove the pipe works with the `hogsend` CLI

After wiring, verify end-to-end with the `hogsend` CLI (ships with
`@hogsend/cli`; run via `pnpm dlx @hogsend/cli` or a global install). It reads
the same env names the host app uses:

- **Base URL:** `--url <baseUrl>` > `HOGSEND_API_URL` > default
  `http://localhost:3002`.
- **Data key** (writes — `events send`): `--data-key` > `HOGSEND_DATA_KEY` >
  `HOGSEND_API_KEY`. The ingest key the host app already has works here.
- **Admin key** (reads — `events <userId>`, `contacts`, `stats`):
  `--admin-key` > `HOGSEND_ADMIN_KEY` > `ADMIN_API_KEY`. Ask the user for one
  if the host env only carries the ingest key.

Always pass `--json` when parsing output programmatically.

## 0. Is the instance reachable?

```bash
hogsend doctor --json
```

Expect verdict `ok` (unauthenticated `/v1/health` — needs no key). If
`unreachable`, fix `HOGSEND_API_URL` before debugging anything else.

## 1. Fire a synthetic event through the data plane

```bash
TEST_ID="test_agent_$(date +%s)"
hogsend events send signup --user-id "$TEST_ID" --prop source=integration-test --json
```

Expected output (202 path):

```json
{ "stored": true, "exits": [] }
```

`stored: true` = the event row is durably written. This proves base URL + key +
scope are right, independent of the host app's code.

## 2. Confirm it landed (read path, admin key)

```bash
hogsend events "$TEST_ID" --json
```

Expect one `signup` event with `properties.source = "integration-test"`. Also
useful:

```bash
hogsend contacts get "$TEST_ID" --json      # contact upserted by ingestion
hogsend contacts timeline "$TEST_ID" --json # merged event/email/journey view
```

## 3. Exercise the REAL seam

Trigger the actual code path you wired — sign a test user up, or replay a
provider webhook (`stripe trigger checkout.session.completed` with the Stripe
CLI, Clerk's "Send Example" button). Then re-run step 2 with the real user's
id/email and confirm the event + contact appear.

## 4. Did anything react?

If journeys are defined on the Hogsend side, the send result's `exits` array
and `hogsend journeys list --json` (enabled journeys + state counts) show
whether the event enrolled/exited anyone. No journeys reacting is fine at this
stage — wiring the host comes first; authoring journeys is the
hogsend-authoring-journeys skill.

## Triage table

| Symptom | Likely cause |
|---|---|
| `doctor` verdict `unreachable` | wrong `HOGSEND_API_URL`, instance down |
| 401 on `events send` | key lacks the `ingest` scope, or wrong key entirely |
| 401 on `events <userId>` | read path needs the ADMIN key, not the ingest key |
| `stored: false` | deduped — you re-sent an `idempotencyKey` already used |
| send ok, but nothing from the real seam | host code path not firing — log inside the seam, check the server actually restarted with new env |
| `RateLimitError` in app logs | back off `retryAfter` seconds; batch less aggressively |

## Clean up

Synthetic `test_agent_*` contacts can be removed via the SDK
(`hogsend.contacts.delete({ userId: TEST_ID })`) or left — they're inert
without an email address.
