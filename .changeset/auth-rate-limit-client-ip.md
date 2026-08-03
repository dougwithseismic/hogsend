---
"@hogsend/engine": patch
"@hogsend/attribution": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/js": patch
"@hogsend/mcp": patch
"@hogsend/plugin-apollo": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-meta-capi": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"@hogsend/plugin-twilio": patch
"@hogsend/react": patch
"@hogsend/sms": patch
"@hogsend/studio": patch
"@hogsend/testing": patch
"@hogsend/video": patch
"hogsend": patch
---

Resolve the client IP for Better Auth's rate limiter behind Railway's edge. Better Auth ≥1.6.25 refuses a multi-valued `x-forwarded-for` when no `trustedProxies` are configured, and Railway always sends two values — so every caller collapsed onto one shared `/sign-in/email` bucket, and ten failed logins by anyone locked the endpoint for everyone. The engine now sets `advanced.ipAddress.ipAddressHeaders` to `["x-real-ip", "x-forwarded-for"]`; `x-real-ip` is single-valued and overwritten by Railway's edge, so it cannot be forged to dodge the limiter.
