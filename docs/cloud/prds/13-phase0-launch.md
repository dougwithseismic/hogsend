# PRD 13 — Phase 0: the smallest truthful launch

Status: `[ ]` not started. Depends on 04, 05, 07, 08.

This PRD is the execution plan for **Phase 0** in [GUIDE.md](../GUIDE.md) §10,
plus the CLI seam Doug asked about on 2026-08-03. When every task here is done,
a hand-invited stranger can sign up, get a running instance, open their own
Studio, point their own repo at it, and publish. That is the launch bar.

Two advisory passes fed this document (2026-08-03). Their findings are folded in
below and marked where they change earlier plans.

## Why these tasks and not others

A provisioned tenant today is **healthy and inert**. Verified in the code:

- `apps/cloud/src/pipeline/provision.ts:443-462` — `mint-credentials` is a
  recorded no-op. It writes `credentialsMinted: false` and moves on.
- `apps/cloud/src/pipeline/provision.ts:582` — provisioning seeds
  `HOGSEND_BOOTSTRAP_API_KEY: "false"` on purpose, so the instance will not
  self-issue a credential. `STUDIO_ADMIN_EMAIL` is never set.
- `apps/cloud/src/worker.ts` registers provision, health-poll, billing-sweep,
  run-build and build-sweep. **No sweep re-drives a parked provision.** The
  health sweep only polls running stacks.

So the customer gets an instance with no admin and no API key, and a failed
provision has nobody to resume it.

The build pipeline already solved the second problem for builds.
`apps/cloud/src/pipeline/build-sweep.ts` is the pattern to copy: orphan pickup,
reaping the interrupted, draining the queue, deliberately serial, small batches.
Do not invent a new shape.

## Tasks

### T1 — Provision re-drive sweep `[x]`

Railway's API degrades for calls made from inside Railway. Provisioning bursts
draw persistent `Problem processing request` 400s. The retry budget was already
widened to ~63s and still exhausted, parking stacks at `error`. The same
pipeline run from a laptop completes every call. So the fix is a sweep, not a
longer inline retry. Every provision step is idempotent and each run
demonstrably advances the stack, so re-driving converges.

Build `apps/cloud/src/pipeline/provision-sweep.ts` modelled on `build-sweep.ts`.

It must re-drive a stack when **any** of these hold:

1. `status = 'error'` and the recorded failure step is a provision step.
2. `status = 'provisioning'` with no write for longer than the stale window.
3. **`status = 'running'` but `substrateRefs.credentialsMinted` is not `true`.**
   This case is the seam between T1 and T2 and is easy to miss. The pipeline
   marks a stack `running` at `finish`, so a mint that fails after that point
   leaves a stack that looks healthy, is not, and matches neither of the first
   two conditions. Sweep it.

Requirements:

- Serial, one stack per tick, with a gap between mutations. The sweep runs
  inside Railway too, so it inherits the same degraded egress it is retrying
  against. Pacing is part of the fix, not a nicety.
- A per-stack attempt counter and a ceiling. A stack that fails N sweeps stops
  being retried and starts being alerted about. Silent infinite retry is its own
  outage.
- Never re-drive a stack a human has suspended or deleted.
- Tests: a killed-mid-run provision converges on the next tick; a `running`
  stack with `credentialsMinted: false` is picked up; a suspended stack is not;
  the attempt ceiling holds.

Effort: 4-6h.

### T2 — Mint credentials for real `[x]`

GUIDE §3.3 is right that this needs **no engine change**. The control plane
already stores each tenant's DSN and its `BETTER_AUTH_SECRET`, and the engine
exports the `createAdminUser` primitive the CLI uses.

Replace the stub at `provision.ts:443` with a step that:

1. Creates the customer's Studio admin against the tenant DSN, using the org
   owner's email and a generated password.
2. Signs in as that admin over HTTP and mints an ingest-scoped API key through
   the instance's own admin endpoint, which returns the full key exactly once.
3. Stores the key encrypted, sets `credentialsMinted: true`, and records the
   Studio password for a single reveal in the dashboard.

Also set `STUDIO_ADMIN_EMAIL` in `assembleStackEnv` so Studio stops answering
"needs setup".

**Idempotency is the whole job.** This step runs against a freshly deployed
instance over HTTP against a DSN, which are the two flakiest things in the
system. Every half-completed state must be recoverable on a re-drive:

- Admin exists but key mint failed → re-mint the key, do not duplicate the user.
- Key minted but the encrypted store write failed → the key is lost; revoke and
  re-mint rather than leaving a live credential nobody holds.
- Run the whole step twice in a test and assert one admin and one live key.

Effort: 6-8h.

### T3 — Non-running alert `[x]`

SEAM: set `CLOUD_OPERATOR_EMAIL=ops@hogsend.com` on the deployed control plane
(both `cloud-app` and `cloud-worker`). Until it is set, notices go to the
server log rather than to a human — the right default for a local run and the
wrong one for production.

`ops@hogsend.com` exists as of 2026-08-03: a Cloudflare Email Routing rule on
the `hogsend.com` zone forwards it to doug@withseismic.com, alongside the
pre-existing `hello@` rule and catch-all. Deliberately a separate address from
`hello@` so fleet noise stays out of the inbox customers write to.

Not set on Railway yet, on purpose: the alert code ships with this branch, so
setting the variable now would redeploy the control plane for a variable
nothing reads. Set it as part of the deploy.

A sweep with no alert is a quieter version of the same bug. Some failure classes
never converge, including the `Not Authorized` class already in the RUNBOOK.

Alert when a stack has been non-`running` for longer than N minutes, or has hit
the T1 attempt ceiling. A Discord webhook to Doug is sufficient. Reuse the
existing cloud email or connector wiring rather than adding a dependency.

Effort: 1h.

### T4 — Environment page: the first five minutes

Today the environment page shows topology, engine version, tenant database and
Hatchet namespace. That is an operator's view of infrastructure, not a
customer's view of their product. The Studio URL is not even a link; it renders
as plain monospace text.

Make it:

- **Open Studio** as the primary action, a real link, with the one-time password
  revealed once and a prompt to change it.
- The instance URL and a copy-paste snippet with a **real API key already filled
  in** (from T2).
- API keys listed, with create and revoke. The engine already has the right
  model: secret `hsk_` keys with scopes, publishable `pk_` keys locked to
  `ingest-public` with a required browser-origin allowlist. The dashboard only
  needs to expose it.
- Provisioning progress in plain language: which step, since when, and "we are
  retrying" rather than silence.

Effort: 3-4h.

### T5 — The CLI seam (scaffold ↔ Cloud)

Advisory verdict: **the PostHog cloud-vs-self-host fork is the wrong analogy.**
PostHog asks because the choice decides which product you use, and cloud users
never touch the repo. For Hogsend the repo IS the product. Everyone scaffolds,
everyone gets the same repo, and hosting is a later decision with zero
migration cost. Forking the scaffold flow would imply two products and create a
branch to maintain.

So: **no new prompt in `create-hogsend`.** Copy only.

- Scaffold outro prints the three paths: `pnpm dev` to run it,
  `hogsend login && hogsend publish` to host on Cloud, README for self-host.
- Template README gains a short "Hosting" section saying the same.
- Dashboard empty state and the onboarding email tell a web-first signup the
  same four commands, so someone who signed up before they had a repo knows
  what to do. Their instance is already running the default scaffold image, so
  publish replaces it rather than creating it.

Do **not** put `hogsend login` inside the scaffolder. It would couple the
scaffolder to Cloud, break headless and `--yes` runs, and punish the majority
who self-host. Login authenticates a machine, not a repo; the credential store
is per-host in `~/.hogsend/`, so there is no ordering problem to solve.

Already shipped and unchanged: `hogsend login` (device flow), `whoami`,
`logout`, `publish`, `open`.

Effort: 2-3h.

### T6 — `hogsend env pull`

The command that makes "I signed up on the web, now point my repo at it" a
one-liner. Fetches the tenant instance URL and API key from Cloud and merges
`HOGSEND_API_URL` plus the key into the local `.env`.

- Needs a new authed endpoint on the control plane to serve the stored
  credentials to a logged-in CLI session.
- Depends on T2. Without minted credentials there is nothing to pull.
- Merge into `.env`, never overwrite it. Never write secrets to stdout.
- Explicitly a **command**, not a login side effect. Login must not silently
  write files into whatever repo the user happens to be standing in.

Effort: 3-4h.

## Explicitly out of scope for Phase 0

Cut on advice, with the reason:

- **Suspend switch** — moved from launch blocker to **money** blocker. Phase 0
  is hand-invited people Doug knows, on test-mode Stripe. Abuse risk is near
  zero. Build it before the first invoice, not before the first invite.
- **Export and destroy** (PRD 12) — money blocker, same reasoning.
- **`cloud.hogsend.com` DNS** — the unguessable URL is fine for hand-invites.
- **Legal copy** — invitees on test Stripe.
- **One-click SSO / OIDC** (GUIDE §3.2) — Phase 1.
- **`hogsend publish` registry credentials and the build host** (PRD 08 seam) —
  customers run the stock scaffold image, which is an honest beta position as
  long as the docs say so.
- **`hogsend link` and a `.hogsend` project file** — publish already resolves
  environments by name, and single-environment tenants need no disambiguation.
  Revisit with PRD 09 multi-env.
- **`hogsend logs` / `hogsend status`** — `hogsend open` covers it.

## Gates

Per repo law, every task ends with: simplify pass, review, a **real** smoke test
against running infrastructure (not just vitest), then one commit.

**Run tests against the dedicated databases**, not the shared dev ones:

```
HOGSEND_TEST_DATABASE_URL=postgres://growthhog:growthhog@localhost:5434/growthhog_test
HOGSEND_CLOUD_TEST_DATABASE_URL=postgres://growthhog:growthhog@localhost:5434/hogsend_cloud_test
```

Both are set in `.claude/settings.local.json` so every session inherits them.
The shared `growthhog` / `hogsend_cloud` databases accumulate rows from killed
runs and from local development, which collide with deterministic fixtures
(`api_keys_key_hash_unique`) and inflate the unscoped health sweep. On a clean
database the suites are 2266/2266 and 720/720 green. If a suite suddenly fails
on duplicate keys or an off-by-one count, suspect the database before the diff.

T1, T2 and T6 are not provable by unit tests alone. Each needs a real run
against the deployed control plane and a real tenant. The two throwaway tenants
(`Live Proof Co`, `Launch Canary Co`) exist for exactly this.

## Order

T1 → T3 → T2 → T4 → T5 → T6.

T1 and T3 first because they make every later failure visible and recoverable,
which is what makes the rest safe to iterate on. T5 is copy and can slot in
anywhere. T6 is last because it depends on T2.
