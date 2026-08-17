---
"@hogsend/js": minor
"@hogsend/engine": minor
"create-hogsend": minor
---

Drop-in `<script>` build of the browser SDK. `@hogsend/js` now ships `dist/hogsend.js`, a self-booting IIFE that reads `data-key`/`data-host`/`data-user-id`/`data-user-token`/`data-pageview` off its script tag, replays a `window.hogsend._q` stub queue, assigns `window.hogsend`, and fires `hogsend:ready`. The engine serves it first-party at `GET /hogsend.js` with a content-hash ETag, `max-age=300, stale-while-revalidate=86400`, and `Cross-Origin-Resource-Policy: cross-origin` (best-effort: 404 when `@hogsend/js` is not installed, override with `HOGSEND_JS_PATH`). New scaffolds depend on `@hogsend/js` so the route works out of the box. The drop-in also carries `data-datalayer="push"` / `data-datalayer-watch` (GTM bridge), `data-connect`, and a `hogsend.ui` namespace with vanilla `banner()` / `toasts()` renderers (also importable as `@hogsend/js/ui`).
