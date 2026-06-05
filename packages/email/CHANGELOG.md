# @hogsend/email

## 0.5.0

### Minor Changes

- f4e604e: Version-line alignment — no functional changes. Bumped to keep all
  scaffold-pinned packages on the engine `0.5.x` minor line so the caret-pinned
  (`^{{ENGINE_VERSION}}`) `create-hogsend` template resolves every `@hogsend/*`
  dependency. (`@hogsend/email` also picks up a README refresh documenting that the
  `EmailProvider` contract now lives in `@hogsend/core`.)

## 0.4.0

### Minor Changes

- 0db58c6: Align the scaffold-pinned packages to the engine 0.4 line (no functional changes) so a fresh `create-hogsend` install resolves every `@hogsend/*` dependency on one compatible minor. Remember to bump `ENGINE_VERSION` in `packages/create-hogsend/src/template-manifest.ts` to match in the Version PR.

## 0.1.0

### Minor Changes

- 3601a18: Align the supporting packages to the 0.1.0 release line. A scaffolded app pins every `@hogsend/*` dependency to a single exact version token, so all published packages must share one version line. These three lagged at 0.0.1 while the engine line moved to 0.1.0, which would leave a fresh scaffold unable to resolve its dependencies.
