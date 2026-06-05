# @hogsend/plugin-posthog

## 0.5.0

### Minor Changes

- f4e604e: Relocate the capability-provider contracts to `@hogsend/core`. The `EmailProvider`
  and `PostHogService` interfaces (and their supporting types — `SendEmailOptions`,
  `BatchEmailItem`, `SendResult`, `WebhookEvent`, `WebhookEventType`,
  `WebhookHandlerMap`, `CaptureOptions`) now live in `@hogsend/core` and are
  re-exported from `@hogsend/engine` as the canonical author import. The vendor
  plugins (`@hogsend/plugin-resend`, `@hogsend/plugin-posthog`) re-export them
  unchanged, so existing imports keep working — no breaking changes. A custom email
  provider now implements `import type { EmailProvider } from "@hogsend/engine"`
  (the contract no longer lives inside the Resend package). See
  `docs/adr/0001-provider-boundary.md`.

  Also makes the injected provider/analytics instances load-bearing: a swapped
  `opts.analytics` is now honored in journey context, the bucket→PostHog sync, and
  worker shutdown (previously these bypassed it via the module singleton), and the
  built-in `send-email` task and alert notifications now deliver through the
  injected `EmailProvider` instead of constructing a raw Resend client — so a
  swapped provider takes effect everywhere. The `send-email` task no longer
  double-retries on top of the provider's own retry loop.

### Patch Changes

- Updated dependencies [f4e604e]
  - @hogsend/core@0.5.0

## 0.4.0

### Minor Changes

- 0db58c6: Align the scaffold-pinned packages to the engine 0.4 line (no functional changes) so a fresh `create-hogsend` install resolves every `@hogsend/*` dependency on one compatible minor. Remember to bump `ENGINE_VERSION` in `packages/create-hogsend/src/template-manifest.ts` to match in the Version PR.

## 0.1.0

### Minor Changes

- 3601a18: Align the supporting packages to the 0.1.0 release line. A scaffolded app pins every `@hogsend/*` dependency to a single exact version token, so all published packages must share one version line. These three lagged at 0.0.1 while the engine line moved to 0.1.0, which would leave a fresh scaffold unable to resolve its dependencies.
