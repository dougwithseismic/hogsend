# DECISIONS — Hogsend

Settled choices every round inherits. Don't relitigate; add new calls with a
date. Product narrative lives in [competitive-positioning.md](competitive-positioning.md)
and [product-spec.md](product-spec.md); architecture rules live in the root
`CLAUDE.md`. Earlier plan runs are archived under [archive/](archive/).

## How autopilot runs here

- **Status**: `Running` (since 2026-11-21).
- **Brief** (2026-11-21, the user's words): "pull the origin main here and look at
  refactoring for performance and extensibility anywhere that you think might
  benefit from code rewrites … do some deep research online as to what, if any,
  features are required here, just working in autonomous fashion to build the
  best version of … hogsend." Invoked via `/autopilot`.
- **Ship rights** (2026-11-21, granted by the `/autopilot` brief): push feature
  branches, open PRs, merge PRs once the required checks are green, merge the
  changesets "Version Packages" PR (CI publishes `@hogsend/*` to npm), and
  deploy the docs site. NOT covered: re-provisioning torn-down production
  infrastructure, DNS/domain changes, anything billed beyond existing Railway
  usage, live payments. Never bypass branch protection (`--admin`).
- **Base branch**: `main`. Protected: required checks `Release integrity`,
  `Lint & types`, `Tests`; no reviews required; admins not enforced (still never
  bypass). Because direct pushes are off-limits, **claims are the round's open
  PR**, and `docs/BACKLOG.md` edits ride in each round's PR.
- **Branches**: `autopilot/<nn>-<slug>` from up-to-date `origin/main`, one
  worktree per round.
- **Deploy targets**:
  1. **npm** — the product is a versioned engine. A merged PR with a changeset
     makes CI open/update "Version Packages"; merging that publishes
     (`.github/workflows/release.yml`, rules in [RELEASING.md](RELEASING.md)).
     Refactors ship as `patch`, additive features as `minor`. No majors without
     the user.
  2. **Docs site** `https://hogsend.com` — Railway project `hogsend-site`
     (`b3ecea61-7d7f-4043-91c0-fed0239da067`), env `production`, service
     `hogsend-docs`. Last good deploy 2026-09-23 via `railway up`.
  3. **Dogfood API** `api.hogsend.com` and **Cloud** `cloud.hogsend.com` —
     OFFLINE (see Needs you in the backlog). The Railway project `Hogsend`
     (`eeeba29d-9c44-4247-a412-f71f2e2eed2c`) has no `production` environment
     left and the `hogsend-cloud` project is gone. Not re-provisioned
     unattended.
- **The real surface**: (a) `npm view @hogsend/engine version` shows the
  released version; (b) a fresh `pnpm dlx create-hogsend@latest` scaffold
  installs, migrates and answers `GET /v1/health` 200 against local Docker;
  (c) `https://hogsend.com` pages read as text in the browser pane.
- **Local gates** (from the worktree root): `pnpm lint`, `pnpm exec turbo run
  check-types`, `pnpm test` with `HOGSEND_TEST_DATABASE_URL` /
  `HOGSEND_TEST_REDIS_URL` pointed at an isolated Timescale + Redis (this run:
  containers `hogsend-ap-pg` on 5484, `hogsend-ap-redis` on 6430), and
  `pnpm exec turbo run build` for the touched packages.
- **Test account**: none needed (engine; Studio admin is seeded locally).
- **Third-party services changeable unattended**: none. Railway: deploy the
  docs service only.

## Product

- **Category**: lifecycle automation, in code. Audience: technical founders and
  product engineers at product-led software companies (positioning approved
  2026-07-15).
- **Origin**: react to what happens in the product (originally PostHog events)
  faster and more precisely than the incumbents' automation canvases.
- **Shape**: a self-hosted engine consumed as a dependency (`@hogsend/engine`),
  scaffolded with `create-hogsend`. Cloud is a later, separate concern.

## Refactor rules (2026-11-21)

- Performance and extensibility refactors are **behaviour-preserving** unless
  the PRD says otherwise; the existing suite is the contract. Add a test when a
  refactor touches a path the suite doesn't pin.
- No public API breaks in `@hogsend/engine` / `@hogsend/core` exports
  ([engine-boundary.md](engine-boundary.md)). Internal moves keep re-exports.
- New migrations only for indexes or additive columns; generated with
  `pnpm db:generate`, never hand-merged.
