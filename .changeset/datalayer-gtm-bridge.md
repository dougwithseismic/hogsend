---
"@hogsend/js": minor
"@hogsend/react": minor
---

Add a two-way `window.dataLayer` bridge so sites already running GTM/GA4 get
Hogsend value with no new page code. Both directions are off by default,
configured via `createHogsend({ dataLayer })` (and passed through the
`<HogsendProvider>` `dataLayer` prop in `@hogsend/react`).

Inbound (the wedge): `watch` wraps `dataLayer.push` (preserving the original)
and pipes an explicit event allowlist into the capture spine, so existing GTM
instrumentation triggers journeys immediately; pre-existing entries replay on
init. Without a `map` only top-level scalar props are copied (nested GA4
`ecommerce` is dropped); a `map` fully owns rename/reshape/drop. Outbound (CDP
escape hatch): `push` mirrors captured events onto the dataLayer as
`hogsend.<name>` (namespaced to avoid GA4 reserved-key collisions), with
`events` narrowing which mirror out and `transform` reshaping them.

Safe by construction: a two-layer loop guard (`hogsend.*`/`gtm.*` are never
ingested by name, and every bridge-emitted entry carries a non-enumerable
marker so a renaming `transform` still can't loop back in), error isolation so
a throwing `map`/`capture` never propagates out of the host page's own
`dataLayer.push`, one-wrapper-per-array (a second bridge unwraps the prior one),
and zero overhead when off (the `onCapture` tap is only wired when configured).
