# hogsend

## 0.13.2

### Patch Changes

- f6ae542: Claim the bare `hogsend` npm name: a new alias package whose bin forwards to `@hogsend/cli`, so `npx hogsend` / `pnpm dlx hogsend upgrade` work without the scope. `@hogsend/cli` now exports `./bin` (and `./package.json`) to support it.
- Updated dependencies [f6ae542]
  - @hogsend/cli@0.13.2
