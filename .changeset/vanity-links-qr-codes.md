---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Vanity slugs and QR codes on managed links.

**Vanity slugs.** A managed link can now carry an operator-chosen slug — `/l/black-friday` — layered over the UUID short URL. Slugs are 1–64 chars of `[a-z0-9-]` (no leading/trailing hyphen), normalized lowercase at every write, and unique per instance (`links.slug`, migration `0037`). Mint one with `mintLink({ slug })` or `POST /v1/admin/links { slug }` (409 when taken); `PATCH` sets, replaces, or clears it (`slug: null` frees it for reuse). The new root-mounted `GET /l/:slug` redirect resolves the link's canonical tracked row and runs the exact same click pipeline as `/v1/t/c/:id` — same `link_clicks` row, same counters, same `link.clicked` events — so counts never split by entry path. Archived links keep resolving (matching UUID-redirect behavior); clearing the slug is the explicit kill switch. The Studio Links view grows a slug field on create/edit with inline conflict handling and shows the copyable `/l/…` short link.

**QR codes.** Every managed link can render a QR code: `GET /v1/admin/links/:id/qr?format=svg|png&size=64..2048&transparent=true|false` (admin-authed; `transparent` renders a transparent background in both formats, for print/overlay). The code encodes the link's durable scan URL — a second `tracked_links` row (`source: "qr"`, lazily minted, race-safe via a partial unique index, migration `0038`) — never the vanity slug, so printed codes survive slug changes AND destination re-targets (`PATCH` updates the scan row alongside the canonical row). Scans are counted separately: link responses now carry `scanCount` (QR-only subtotal) next to `clickCount` (all-paths total), and `source: "qr"` rides the existing `link.clicked` outbound payload.

**Print-first QR codes with per-destination stats.** Every `link_clicks` row now stamps `destination_url` — the redirect target that was live when that hit landed — so after a re-target, each destination keeps its own numbers: `GET /v1/admin/links/:id` returns a `destinations` array (`url`, `clicks`, `scans`, `firstAt`, `lastAt`; pre-feature rows bucket as `url: null`). Links gain a nullable `description` (mint + PATCH + responses) for telling printed codes apart in bulk, and `GET /v1/admin/links?hasQr=true` filters to links whose QR scan row exists. Studio gains a **QR codes** view over that lens — "New QR code" mints from destination + label + description, and the shared QR dialog adds inline re-targeting, the per-destination breakdown, and a split-button export (PNG / transparent PNG / SVG; the journeys `SplitButton` is now a shared `@hogsend/studio` UI primitive).

**Arrival attribution — "did a known user scan this?"** Opt-in per link (`appendRef`, default false), the redirect appends `hs_ref=<hit id>` to the destination (same URL-build pass as `hs_t`); the landing page reports the visitor back to the new unauthenticated `POST /v1/t/arrive`. Identity is evidence-based and mirrors the existing trust model exactly: a `userToken` proves a userId (`visitor_kind: "token"` — a known contact); a raw anon id is provenance-only, collision-checked against identified contacts before stamping and ingested under `restrictToAnonymous`; a bare asserted email/userId isn't in the schema. The hit row is stamped first-write-wins (replays re-run ingest from the stamped identity via `idempotencyKey link:arrived:<ref>` — self-healing, never re-attribution), and a new **`link.arrived`** event (16th catalog member; bus + outbound) fires with the visitor's identity — trigger journeys on it, filtered by `linkId`/`campaign`/`source: "qr"`. Every outcome answers `200 {"ok":true}` (no contact-existence oracle). Link detail gains `arrivalCount`/`identifiedArrivalCount` + stamp fields on `clicks[]`; Studio gets the "Append arrival ref" toggle (QR create defaults ON) and known-contact arrival counts in the QR dialog. `@hogsend/js` auto-captures `hs_ref` on init (config `captureRef: false` to disable; manual `hogsend.captureRef()` for SPAs).

Migrations `0037`/`0038`/`0039`/`0040` are additive (nullable columns + indexes + a default-false boolean) — no data changes, no breaking API changes. New engine dependency: `qrcode` (mirrored in the create-hogsend template).
