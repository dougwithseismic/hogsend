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

Fix `hogsend upgrade` breaking existing consumers' type-checking after a new engine dependency ships.

`@hogsend/engine` ships raw `.ts` source (no build step), so a consumer's own `tsc` type-checks engine's source directly against whatever is in the consumer's `node_modules`. `@types/qrcode` and `@types/papaparse` were declared in the engine's `devDependencies` — which never propagate to consumers — instead of `dependencies`. Any consumer scaffolded before the vanity-links/QR feature (#385) landed hit a `TS7016` on `qrcode` the moment `hogsend upgrade` bumped them past 0.40.0, even though `check-types`/build succeeded in this repo.

Moved both `@types/*` packages to `dependencies` so they install transitively for every consumer, old and new, regardless of whether `hogsend upgrade` or a fresh `create-hogsend` scaffold picked them up.
