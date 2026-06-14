---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

fix(connect): purge derived credentials on disconnect, enforce minted secret immediately, validate region URL

Fast-follows on the one-click PostHog connect:

- Disconnect (`DELETE /v1/admin/provider-credentials/:providerId`) now purges
  the `derived` credential row (minted webhook secret + grabbed `phc_`) too,
  not just the oauth grant — no orphaned rows linger.
- The inbound webhook source's secret cache is busted the moment connect mints
  a secret, so it is enforced immediately instead of after the ~30s recheck TTL.
- Removed the now-unreachable `webhook_secret_missing` 409 branch (the loop
  always resolves or mints a secret before provisioning).
- The CLI region prompt validates a custom host URL up front instead of
  surfacing a cryptic "Failed to parse URL" during discovery.
