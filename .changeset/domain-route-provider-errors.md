---
"@hogsend/engine": patch
"@hogsend/cli": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/studio": patch
---

fix: surface provider domains-API failures as 502 with the provider message

`GET/POST /v1/admin/domain` (and `/verify`) let a provider error — e.g. a
send-only restricted Resend key that cannot read the domains API — escape as
an opaque 500. The routes now catch provider failures and return
`502 { error: "domains request to provider \"resend\" failed: …" }`, which
`hogsend domain status` and Studio's Setup view render directly, so a
restricted key tells you exactly what to fix (use a full-access key) instead
of "Internal Server Error". Found by the live test-mode smoke; the send path
was already fail-open and unaffected.

The rest of the engine-line packages bump in lockstep to keep the version
line uniform; they carry no functional change here.
