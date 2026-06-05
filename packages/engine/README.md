# @hogsend/engine

The Hogsend framework: `createApp`, `createHogsendClient`, `createWorker`,
`defineJourney`, `defineWebhookSource`, the ingestion + tracking pipeline, the
built-in routes, and the registries. This is the public API surface consumers
build their lifecycle apps on top of.

The engine also re-exports the capability-provider contracts owned by
`@hogsend/core` — `EmailProvider` and `PostHogService` (plus their supporting
types) — so `@hogsend/engine` is the **canonical author import** for them when
writing a custom provider. (The contract-level `SendEmailOptions` is the one
exception: it stays on `@hogsend/core`, since the engine exports a different,
higher-level `SendEmailOptions`.) See
[docs/adr/0001-provider-boundary.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/adr/0001-provider-boundary.md).

Scaffold a consumer app with `pnpm dlx create-hogsend@latest`. The engine line
(`@hogsend/engine`, `@hogsend/db`, `@hogsend/core`) is versioned in lockstep so a
new engine migration always bumps the engine and DB together; the boot guard
asserts the database ledger matches the bundled migrations. See
[engine-boundary.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/engine-boundary.md)
for the committed API surface and
[RELEASING.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md)
for semver discipline.

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`).
