---
"create-hogsend": minor
---

feat: make the first run actually work on pnpm 11, and stop implying PostHog is a dependency

- **pnpm 11 install no longer fails.** The scaffold ships a settings `pnpm-workspace.yaml` (`allowBuilds` for `@hatchet-dev/typescript-sdk`, `esbuild`, `protobufjs`; `minimumReleaseAgeExclude` for `@hogsend/*` so same-day releases install) — without it pnpm 11 hard-failed the scaffold's own install with `ERR_PNPM_IGNORED_BUILDS` and quarantined release-day engine versions. It also marks the app as its own workspace root, so scaffolding inside a monorepo can't leak into a parent workspace.
- **Bootstrap can't lie anymore.** After `db:migrate` it verifies the ENGINE migration ledger actually reached HEAD (the same probe the API boot guard runs) and dies loudly if not; step failures (key mint, admin create) are recorded and re-surfaced in a "finished with issues" summary with exit code 1 instead of an unconditional "✓ Ready."
- **Bootstrap mints TWO keys**: `HOGSEND_API_KEY` (ingest) as before, plus `HOGSEND_ADMIN_KEY` (full-admin) so `hogsend connect posthog` and the other admin CLI commands work out of the box against the local instance.
- **Source-neutral event-source prompt.** "Are you using PostHog?" (default yes, followed by a phc_ key + region interview nobody needs at scaffold time — the connect flow discovers the key itself via OAuth) is replaced by a "Where will events come from?" multi-select: "My app code" (pre-wired `@hogsend/client`, zero config) comes pre-ticked, PostHog can be ticked alongside it (sources aren't mutually exclusive) and only gates the post-deploy `hogsend connect posthog` hint, and selecting nothing is a valid "not sure yet". `--posthog-key` / `--no-posthog` remain as escape hatches.
- **No more placeholder Resend key.** `env.example` ships `RESEND_API_KEY` commented out — the app now boots fine without it (engine ≥ this release) instead of warning about a fake key's "native tracking".
- The `--use-tarballs` verify harness writes its `@hogsend/*` overrides into `pnpm-workspace.yaml` too (pnpm 11 ignores `package.json#pnpm.overrides`, which silently resolved transitive deps from the registry).
