---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/email": patch
"@hogsend/db": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Give the engine's Better Auth its own cookie namespace so the Studio stops fighting a sibling web app's SSO cookie.

The engine's Better Auth (the Studio, e.g. `t.hogsend.com`) used Better Auth's default cookie name (`__Secure-better-auth.session_token`) with no prefix. A sibling web app on the shared parent domain can set a cross-subdomain SSO cookie of that SAME default name (e.g. `crossSubDomainCookies: { domain: ".hogsend.com" }`), which the browser also delivers to the Studio host. The engine reads it under the shared name, looks the token up in its OWN database — a different DB — finds nothing, and `get-session` returns null, so the Studio bounces back to login in a loop even though the user "has a session" on the sibling app.

The engine now sets `advanced.cookiePrefix`, so its session cookie is `__Secure-hogsend.session_token` (dev/http: `hogsend.session_token`) and no longer collides. The prefix is configurable via a new optional env `AUTH_COOKIE_PREFIX` (default `"hogsend"`), plumbed `env.ts → container.ts → createAuth`. This is server-config-only — no client, middleware, or literal cookie-name changes: every consumer resolves the session through `auth.api.getSession(...)`, which derives the prefixed name from the same options.

Any sibling web app that intentionally shares a cross-subdomain cookie keeps Better Auth's default prefix, so its own single-sign-on is fully preserved; the two cookies simply no longer share a name.

Note: renaming the cookie logs existing Studio sessions out ONCE (they must sign in again to mint a cookie under the new name). There is no database migration — session rows are untouched, and the old cookie lingers ignored until it expires. CLI-created and `STUDIO_ADMIN_*` bootstrap admins are unaffected. `AUTH_COOKIE_PREFIX` does not need to be set on any deploy; the `"hogsend"` default is authoritative.
