# Execution plan — Sources & Prospects

Driven top-to-bottom by the **autonomous-loop** skill: build each feature fully → pass gates (`pnpm check-types`, `pnpm lint`, `pnpm build`) → verify it actually works → **one commit per feature** → flip its status marker here. Phase-boundary cleanup is a separate commit. Build to external seams (Fake + recorded ask), never block.

**Status legend:** `[ ]` todo · `[~]` built-to-seam (in-repo done, waiting on a human/external ask) · `[x]` done.

**Guardrails (from global instructions):** never push; no `Co-Authored-By`; no Claude/Anthropic mention in commits; `pnpm add <pkg>@latest` over hand-editing `package.json`; verify before claiming done.

---

## Phase 0 — Foundations: provenance + fail-closed consent

*The load-bearing, legally-significant part. Build first — nothing outbound may send on a warmer channel until this is in place.*

- [ ] **0.1 Contact provenance columns.** Add `contacts.source` (text, nullable) + `contacts.sourcedAt` (timestamptz, nullable) in `packages/db/src/schema/contacts.ts`; generate + run the migration on the engine track (`cd packages/db && pnpm db:generate`). Mirror how `discordId` was added. Enrichment continues to land in `properties` via the existing `contactProperties` merge — do **not** add per-field columns.
  - *Accept:* migration applies clean; a contact created via ingest with a `source` writes both columns; existing contacts unaffected (nullable).

- [ ] **0.2 Cold-channel polarity.** Make the `defaultOptIn` of synthesized channels configurable in `synthesizeChannelLists` (`packages/engine/src/lists/channels.ts`) — **default stays `true`** (zero behaviour change). Introduce a `coldChannels` config (set of channel ids) that renders those channels `defaultOptIn:false` (fail-closed). No new table — same `email_preferences.categories` namespace; `ListRegistry.isSubscribed` already enforces `defaultOptIn:false` as "subscribed only when explicitly true".
  - *Accept:* a channel in `coldChannels` reports **not subscribed** for a contact with no category entry; a normal channel is unchanged (subscribed unless explicit `false`).

- [ ] **0.3 Fail-closed gate for cold contacts.** In `checkActionAudience` (`packages/engine/src/lib/connector-actions.ts`), when the resolved recipient is a **cold/sourced** contact and the channel is non-email: an unresolved ref **or** a not-explicitly-opted-in channel → **skip** (`channel_unsubscribed`), not allow. Preserve today's fail-**open** behaviour for non-cold contacts (no regression) — key the flip off provenance + `coldChannels`.
  - *Accept:* a member-directed connector send to a cold prospect with no opt-in is **skipped**; the same send to an engaged/opted-in contact still fires; existing connector tests stay green.

- [ ] **0.4 The "unflick" override.** An explicit, documented per-source / per-channel `coldPosture` map (e.g. `{ email: "allow", sms: "block", discord: "block" }`) with legal-safe defaults (email allow, everything else block). Loosening a non-email channel to `allow` is a deliberate, logged operator action. Document the whole model in [`consent-and-legal.md`](./consent-and-legal.md).
  - *Accept:* default posture blocks all non-email cold sends; setting `discord: "allow"` on a source lets that one channel through and emits a log line recording the deliberate loosening.

## Phase 1 — `defineContactSource` + generic webhook source

- [ ] **1.1 `defineContactSource()` primitive.** New `packages/engine/src/sources/` module. Shape: `{ meta, auth, schema?, transform, writeBack?, coldPosture? }`. Inbound `transform` returns a sourcing `IngestEvent` (provenance + no-consent posture applied). Optional `writeBack` adapter interface (called on journey milestones). Register via `createHogsendClient({ contactSources })` / `createApp`; internally lift each to the existing connector/webhook registry (reuse `webhookSourceToConnector`).
  - *Accept:* a registered contact source is served at `POST /v1/webhooks/:sourceId`; its transform output flows through `ingestEvent`.

- [ ] **1.2 Generic webhook source (built-in).** A `defineContactSource` accepting a normalized payload `{ event, email, external_id?, properties }`; shared-secret / HMAC header auth (reuse the webhook-source `signature` | `match` auth union). This is the day-one path for HubSpot/Salesforce/Outreach/Zapier.
  - *Accept:* a signed POST creates/updates a prospect; a bad signature is rejected; docs show the payload contract.

- [ ] **1.3 Sourcing → upsert with provenance + idempotency.** Stamp `source`/`sourcedAt`, merge enrichment into `properties` (reuse `resolveOrCreateContact` + `contactProperties`), and dedup on a source-provided idempotency key so retries / auto-update re-fires do **not** re-enroll.
  - *Accept:* two identical POSTs (same idempotency key) yield one contact and one enrollment; enrichment lands in `properties`.

## Phase 2 — Clay adapter *(external seam: live Clay workspace)*

- [ ] **2.1 Clay contact source.** Payload mapping: email as anchor, LinkedIn-URL fallback key when email is absent, enrichment → `properties`; idempotency on `clay_row_id`; shared-secret header. Endpoint returns a fast `200` JSON ack (Clay retries → must be idempotent). Ship a deterministic **Fake** payload fixture for local E2E.
  - *Accept:* the Fake Clay payload upserts a prospect with LinkedIn/company/title in `properties`; re-POST is a no-op.

- [ ] **2.2 Clay setup recipe (doc).** In this folder: the HTTP-API column config — method POST, our endpoint, stored header secret, **Auto-Update ON**, **"Only run if" valid email + ICP gate**. Built to the Fake. **Seam ask:** real Clay creds for a live end-to-end run. Mark `[~]`.

## Phase 3 — Attio adapter + write-back *(external seam: Attio workspace token)*

- [ ] **3.1 Attio contact source.** Inbound via Attio **Automation → "Send HTTP Request"** (preferred: clean first-party payload, no re-fetch) with a signed **`list-entry.created` webhook** fallback: verify `Attio-Signature` (HMAC-SHA256 of raw body), dedup on the `Idempotency-Key` header, ack in <5s then enqueue. Map person attributes → `properties`. Fake fixtures for both shapes.
  - *Accept:* both the automation-shaped payload and a signed webhook upsert a prospect; a bad signature is rejected; duplicate `Idempotency-Key` is a no-op.

- [ ] **3.2 Attio write-back adapter.** `writeBack` implementation: `PUT /v2/objects/people/records?matching_attribute=email_addresses` to stamp `lifecycle_status` / `last_emailed_at`; `POST /v2/notes` for the human-readable trail. Throttle ≤25 write/s, honour `Retry-After`, and ignore self-authored `actor` to avoid an echo loop. Built against a Fake HTTP client. **Seam ask:** Attio workspace token. Mark `[~]`.
  - *Accept:* on a journey milestone the Fake receives the correct upsert + note payloads, throttled; unit-tested against the Fake.

## Phase 4 — Outbound journey (dogfood) + Studio surfacing

- [ ] **4.1 Example outbound journey.** In the consumer app (`apps/api/src/journeys/`): triggered by a sourcing event, **cold-email-only**, unlocking warmer channels on engagement / explicit opt-in. Dogfood framing = Hogsend sourcing Hogsend prospects.
  - *Accept:* a sourced event enrolls; a cold email sends (tracked, with unsubscribe); no warmer-channel send fires pre-opt-in.

- [ ] **4.2 Studio surfacing.** Surface **Prospects vs Contacts** (provenance filter), per-channel consent-posture visibility, and a read-only Sources list. Studio observes; it does not author sources.
  - *Accept:* the Studio contacts view filters by `source`; a prospect shows its cold consent posture.

- [ ] **4.3 Wire write-back into journey milestones.** Call the Attio `writeBack` at send/opt-in/reply milestones in the example journey.
  - *Accept:* milestones produce the expected Fake write-back calls.

## Phase 5 — Hardening + docs

- [ ] **5.1 Idempotency/retry hardening.** A shared dedup ledger covering Clay retries + Attio at-least-once delivery; property-test the re-POST paths.
- [ ] **5.2 Consent/provenance audit ledger.** Additive migration recording who was sourced, from where, and consent-state changes (an auditable trail — required for the legal posture).
- [ ] **5.3 Final docs + release.** Update engine docs, write the "unflick" runbook, add a changeset (new `@hogsend/*` package(s) may need a manual first publish — see the `release` skill).

---

## Enumerated external seams (built to Fake; need a human)

1. **Live Clay workspace + creds** — for a real Clay-column → ingest E2E (Phase 2.2).
2. **Attio workspace token** — for real inbound automation + write-back (Phase 3.x).
3. **Legal sign-off on cold-email copy** and on any future decision to `allow` a non-email channel for cold contacts (see [`consent-and-legal.md`](./consent-and-legal.md)).

## End-to-end verification (via the `verify` skill — real API+worker on a fresh local DB)

1. `POST /v1/webhooks/{webhook,clay,attio}` with Fake payloads → assert a prospect upserts with `source`/`sourcedAt` + enrichment in `properties`; a re-POST does **not** re-enroll.
2. Enroll the sourced event into the example outbound journey → assert a **cold email sends** (tracked, unsubscribe present) but a **connector send is skipped** (`channel_unsubscribed`).
3. Simulate a first cold-email click with `TRACKING_IDENTITY_TOKEN=true` → assert the anon session stitches onto the email contact.
4. Trigger a journey milestone → assert the Attio Fake receives correct, throttled write-back calls.
