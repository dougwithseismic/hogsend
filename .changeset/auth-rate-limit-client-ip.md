---
"@hogsend/engine": patch
---

Resolve the client IP for Better Auth's rate limiter behind Railway's edge. Better Auth ≥1.6.25 refuses a multi-valued `x-forwarded-for` when no `trustedProxies` are configured, and Railway always sends two values — so every caller collapsed onto one shared `/sign-in/email` bucket, and ten failed logins by anyone locked the endpoint for everyone. The engine now sets `advanced.ipAddress.ipAddressHeaders` to `["x-real-ip", "x-forwarded-for"]`; `x-real-ip` is single-valued and overwritten by Railway's edge, so it cannot be forged to dodge the limiter.
