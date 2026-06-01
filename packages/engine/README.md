# @hogsend/engine

The Hogsend framework: `createApp`, `createHogsendClient`, `createWorker`,
`defineJourney`, `defineWebhookSource`, the ingestion + tracking pipeline, the
built-in routes, and the registries. This is the public API surface consumers
build their lifecycle apps on top of.

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
