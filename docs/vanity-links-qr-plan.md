# Vanity Links + QR Codes — Execution Plan

Two features layered on the managed link tracker (`mintLink` / Studio Links / `/v1/admin/links`, shipped 0.27.0):

1. **Vanity links** — an operator-chosen slug that sits over the top of the UUID short link. `/l/black-friday` resolves the same click pipeline as `/v1/t/c/<uuid>`. Slugs are unique per instance, normalized lowercase, and live on the `links` row (managed links only — email's per-send rewritten links stay UUID-only).
2. **Per-link QR codes** — every managed link can produce a QR code with its own durable key: a second `tracked_links` row (`source: "qr"`) minted lazily per link. The QR encodes `/v1/t/c/<qrTrackedLinkId>` (the durable UID URL, **never** the slug — printed codes must survive slug changes). Retargeting already works: `PATCH /v1/admin/links/:id` updates all `tracked_links` rows scoped by `link_id`. Scans are distinguishable from clicks (`source: "qr"` rides the existing `link.clicked` outbound payload).

## Design decisions

- **Slug rules**: 1–64 chars, `[a-z0-9-]`, no leading/trailing hyphen; input normalized to lowercase before validation. Unique index on `links.slug`. Conflicts → 409. Slug is settable at mint, changeable/clearable via PATCH (`slug: null` frees it). Archived links keep their slug reserved and keep resolving (matches UUID-redirect behavior today).
- **Vanity route**: `GET /l/:slug` mounted at the app root (outside `/v1`) — `/l` collides with nothing (`/v1`, `/studio`, `/docs`, `/api/auth`, `/connectors`, webhooks). Resolution: `links` by slug → canonical tracked row (`source IS DISTINCT FROM 'qr'`) → the exact same click pipeline as `/v1/t/c/:id` (extracted into a shared function, not duplicated, not a double redirect).
- **QR spine**: no new table. `ensureQrTrackedLink()` lazily select-or-inserts the per-link QR row, guarded against races by a partial unique index on `tracked_links(link_id) WHERE source = 'qr'`. `distinctId` copied from the link (personal links' scans still stitch `hs_t`).
- **Aggregates**: `aggregateFor` splits with SQL `FILTER` — `clickCount` stays the total across all rows, `scanCount` = QR-only subtotal, `trackedLinkId` = the canonical non-QR row (today's `min(id)` would pick the QR row arbitrarily).
- **QR generation**: `qrcode` npm package (server-side SVG + PNG, no canvas). New engine dep ⇒ **must** be mirrored in `packages/create-hogsend/template/_package.json` (consumer CJS/ESM boot-crash gotcha, see #263).
- **Admin QR endpoint**: `GET /v1/admin/links/{id}/qr?format=svg|png&size=` behind `requireAdmin`. Studio previews via same-origin `<img>` (session cookie rides along).

## Quality gates (every feature)

`pnpm check-types` · `pnpm lint` · `pnpm build` · `cd apps/api && pnpm test` (docker TimescaleDB on :5434 must be up)

## Status legend

`[ ]` todo · `[~]` built-to-seam (human ask recorded) · `[x]` done

## Phase 1 — Vanity slugs

- [x] 1.1 Slug foundation: `links.slug` column + unique index (migration via `pnpm db:generate`), slug normalize/validate helper, `mintLink({ slug })` + `MintedLink.slug`/`vanityUrl`, admin `POST /v1/admin/links` accepts `slug` (400 invalid, 409 taken), `PATCH` sets/changes/clears slug, `slug` + `vanityUrl` in all link responses — with integration tests (mint, case-normalize, dup 409, clear-and-reuse)
- [x] 1.2 Vanity redirect: extract the shared click pipeline from `routes/tracking/click.ts`, add root-mounted `GET /l/:slug` running it (404→redirect-home behavior matching UUID route), tests (302 + `link_clicks`/`click_count` side effects, retarget reflected, archived slug still resolves, unknown slug)
- [x] 1.3 Studio: slug field in create + edit dialogs (client-side validation mirroring engine), vanity short link shown/copyable in table + reveal dialog, 409 surfaced inline

## Phase 2 — QR codes

- [x] 2.1 QR scan spine: partial unique index migration (`tracked_links(link_id) WHERE source='qr'`), `ensureQrTrackedLink()`, `aggregateFor` FILTER split (`scanCount`, canonical `trackedLinkId`, `qrTrackedLinkId`), `scanCount` in admin link responses — with tests (lazy mint idempotent under race, scan increments scanCount not conflated, retarget covers QR row)
- [x] 2.2 QR endpoint: add `qrcode` dep to engine (+ `@types/qrcode` dev, + mirror in create-hogsend template `_package.json`), `GET /v1/admin/links/{id}/qr` (svg default, png, `size` param, sensible cache headers), encodes durable `/v1/t/c/<qrTrackedLinkId>` — with tests (content-type, deterministic payload URL, 404, lazy-mints the row)
- [ ] 2.3 Studio: QR action per link row → dialog with live preview, PNG/SVG download, scan count; scans surfaced in list view

## Phase 3 — Docs + release prep

- [ ] 3.1 `docs/tracking.md`: managed links / vanity slugs / QR section (doc is currently email-only and stale w.r.t. 0.27); changeset for the engine line (minor: engine, db, studio, create-hogsend)

## Seam notes

No external seams expected — no vendor credentials, no paid infra. `qrcode` is a plain npm dep. Release/publish itself is out of scope for this loop (batched per calm-release discipline; needs Doug's nod). Dogfood app pickup happens via `hogsend upgrade` after release.
