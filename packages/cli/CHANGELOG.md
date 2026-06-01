# @hogsend/cli

## 0.1.0

### Minor Changes

- b150848: Add `@hogsend/cli` with a `hogsend eject <pkg>` command. Eject copies a single
  `@hogsend/*` package's source into `vendor/<name>` and rewrites only that
  consumer dependency to a `file:./vendor/<name>` link, leaving every other
  `@hogsend/*` package upgradable via `pnpm up`. Documented alongside the
  Extend → Patch → Eject ladder in `docs/customizing-the-engine.md`.
