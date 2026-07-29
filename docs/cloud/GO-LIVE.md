# Hogsend Cloud — Go-Live Gate

Status date: 2026-07-29. This document is the checklist: when can we take
Hogsend Cloud live, and what is required of Doug. Nothing goes live until every
box in **Launch blockers** is checked and Doug gives the explicit go.

For the reasoning behind these items — the identity architecture, the phase
order, and the open decisions — read **[GUIDE.md](GUIDE.md)** first.

## Where we are

**The full customer path is proven live, end to end, on real infrastructure:**
signup → email code → org create → Railway provision on shared cell `us-1` →
running managed instance reporting `healthy` (db + redis + worker heartbeat via
the cell's shared Hatchet). PRDs 01–08 shipped (04/06/08 to a seam).

**The control plane is now DEPLOYED** (2026-07-29) at
`https://cloud-app-production-2bc6.up.railway.app` — Railway project
`hogsend-cloud`: `cloud-app`, `cloud-worker`, `cloud-postgres`. Real signup email
via Resend, live Stripe, its own Hatchet tenant on the `us-1` cell. A second
canary (`Launch Canary Co`) was signed up THROUGH the deployed dashboard and
provisioned to a healthy instance at
`https://production-api-production-59fb.up.railway.app`.

**It is not announced and not on a hogsend.com domain.** The URL is unguessable,
there is no `cloud.hogsend.com`, and signups are invite-only by obscurity until
the blockers below clear. Two throwaway tenants exist (`Live Proof Co`,
`Launch Canary Co`) with no real data; destroying them is the natural test of
the offboarding path.

## Launch blockers — engineering (no Doug action needed)

- [x] **Deploy the control plane itself.** DONE 2026-07-29. `Dockerfile.cloud`
      (one image, three run modes) + per-service `railway.cloud*.toml`, deployed
      as a GHCR image to project `hogsend-cloud`. Migrations run as the app's
      pre-deploy; the worker executes provisioning through the cell's Hatchet.
- [x] **Control-plane email.** Already built (`CLOUD_RESEND_API_KEY` +
      `CLOUD_RESEND_FROM` in `lib/email-sender.ts`); dev-log fallback only when
      unset. Remaining work is setting the two vars on the deployed service.
- [ ] **Mint customer credentials** — with the reconciler, the other half of
      Phase 0. `mint-credentials` is a recorded no-op, AND provisioning sets
      `HOGSEND_BOOTSTRAP_API_KEY: "false"` while never setting
      `STUDIO_ADMIN_EMAIL`, so a provisioned tenant has **no admin user and no
      API key**: Studio says "needs setup" and ingest has no key to accept. The
      instance is healthy and inert. Cloud already stores the tenant DSN and its
      `BETTER_AUTH_SECRET`, so this is buildable with no engine change — see
      GUIDE §3.3.
- [ ] **Auto re-drive of parked provisions** (PRD 10 slice) — now the TOP
      blocker. Railway's API answers the worker's provisioning bursts with
      persistent `Problem processing request` 400s; the retry budget was widened
      to ~63s and still exhausted, parking the stack at `error` with nobody to
      resume it. The same pipeline run from a laptop completed every call. So
      calls FROM INSIDE Railway are the degraded path (shared egress, most
      likely), and the fix is not a longer inline retry but a sweep that
      re-drives `error`/`provisioning` stacks on a schedule — every step is
      idempotent and each run demonstrably advances. Until it exists, a stuck
      signup needs a manual re-drive (see RUNBOOK).
- [x] **Stripe wiring** (PRD 06 seam) — DONE 2026-07-29 with the live keys from
      the course service (Doug's authorization). Products/prices created in the
      live catalog (lookup keys `hogsend_cloud_self_serve` $49/mo,
      `hogsend_cloud_dedicated` $149/mo); checkout proven end-to-end through
      the real route to a hosted `checkout.stripe.com` session. Still open:
      `CLOUD_STRIPE_WEBHOOK_SECRET` — the webhook endpoint can only be created
      once the control plane has a public URL; and full payment completion was
      not exercised (live mode rejects test cards — grab the `sk_test`
      counterpart from the dashboard if we want a rehearsal payment).
      UPDATE: the webhook endpoint now EXISTS against the deployed URL and its
      secret is set on both services; a real subscription event has not yet been
      observed end to end.
- [ ] **Tenant image registry credentials.** `hogsend publish` builds work, but
      deploying private tenant images to Railway needs registry-credential
      support on the deploy call. Default (public scaffold) images work today.
- [ ] **Fleet health minimum** (PRD 10): operator view + abuse suspend switch.
      We should not take money without a kill switch.
- [ ] **Offboarding minimum** (PRD 12): data export + stack destroy from the
      dashboard. We should not take money without giving data back.
- [ ] Wave-end PR, review, squash to main, release train (needs Doug's nod —
      see below).

Deferred, NOT blocking launch: PRD 09 (staging/test environments), PRD 11
(dedicated tier / EU region / custom domains), multi-arch images, waitForDeploy
on the substrate seam.

## Launch blockers — Doug's required actions

- [x] **Stripe**: products/prices created in the live account (2026-07-29);
      keys sourced from the course service on Railway per Doug. Optional: hand
      over the `sk_test` counterpart for a test-card checkout rehearsal.
- [ ] **DNS**: point `cloud.hogsend.com` at the control-plane Railway service
      (Cloudflare CNAME, same pattern as api.hogsend.com).
- [ ] **Production secrets rotation**: the deployed control plane currently uses
      the workspace token from `apps/cloud/.env.local` and freshly generated
      auth/encryption secrets (set only as Railway service vars). Bless them, or
      issue dedicated production ones. NOTE: `CLOUD_ENCRYPTION_SECRET` can never
      be rotated casually once tenants exist — every stored provider key and
      cell DSN is encrypted under it.
- [ ] **Legal copy**: review/replace the Terms + Privacy stubs before real
      signups.
- [ ] **Pricing/limits sign-off**: confirm plan limits (events/emails per tier)
      the metering enforces.
- [ ] **Wave-end nod**: approve the PR from this worktree branch so the code
      reaches main and the release train (which also builds the default image
      per publish).
- [ ] Decide the two throwaway tenants' fate: keep one as a staging canary, or
      destroy both (recommended — exercises offboarding and stops the spend).
- [ ] **Discord invite readiness**: the README now points beta hopefuls at the
      Discord. Decide how invites are handled (a #cloud-beta channel, a pinned
      message) before the README change reaches main.

## Sequence to live

1. ~~Stripe keys~~ · ~~control-plane deploy~~ — both done 2026-07-29.
2. Engineering: auto re-drive, mint-credentials, kill switch, export.
3. Wave-end PR → Doug review → merge → release.
4. Doug: DNS + production secrets on the deployed control plane.
5. Private beta: a handful of hand-invited signups on test-mode Stripe.
6. Doug: legal copy + live Stripe keys → public.
