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

**QR codes.** Every managed link can render a QR code: `GET /v1/admin/links/:id/qr?format=svg|png&size=64..2048` (admin-authed). The code encodes the link's durable scan URL — a second `tracked_links` row (`source: "qr"`, lazily minted, race-safe via a partial unique index, migration `0038`) — never the vanity slug, so printed codes survive slug changes AND destination re-targets (`PATCH` updates the scan row alongside the canonical row). Scans are counted separately: link responses now carry `scanCount` (QR-only subtotal) next to `clickCount` (all-paths total), and `source: "qr"` rides the existing `link.clicked` outbound payload. The Studio Links view gets a Scans column and a per-link QR dialog with live preview and PNG/SVG downloads.

Migrations `0037`/`0038` are additive (a nullable column + two indexes) — no data changes, no breaking API changes. New engine dependency: `qrcode` (mirrored in the create-hogsend template).
