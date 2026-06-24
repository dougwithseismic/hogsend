---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Studio: Debug is now a global drawer with a typed (scalar) property builder.

Firing a test event no longer means navigating to a `/debug` page. A **Fire event**
button in the header (and the Overview getting-started CTA) opens a slide-out drawer
from anywhere in Studio, so you can trigger a journey without leaving the page you're
on. The `/debug` route, its sidebar item, and the old page are removed.

The drawer also replaces the raw-JSON properties textarea with a **typed scalar
editor**: each property is a key + a type (string / number / boolean) + a value, so
the test event exercises `POST /v1/admin/events` with the same scalar types real code
sends. Numbers that don't parse to a finite value fail loudly (no silent `NaN`/`null`),
and a duplicate key is rejected rather than silently overwritten.

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
version line.
