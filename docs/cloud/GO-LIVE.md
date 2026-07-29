# Hogsend Cloud — Go-Live Gate

Status date: 2026-07-29. This document is the single answer to "when can we take
Hogsend Cloud live, and what is required of Doug". Nothing goes live until every
box in **Launch blockers** is checked and Doug gives the explicit go.

## Where we are

**The full customer path is proven live, end to end, on real infrastructure:**
signup → email code → org create → Railway provision on shared cell `us-1` →
running managed instance reporting `healthy` (db + redis + worker heartbeat via
the cell's shared Hatchet). PRDs 01–08 shipped (04/06/08 to a seam).

**Nothing is publicly live.** The control plane runs only on localhost. There is
no `cloud.hogsend.com`. The only deployed artifacts are the `us-1` cell
(cell-postgres, hatchet-postgres, hatchet-lite) and one throwaway proof tenant
(`Live Proof Co`, project `hs-org-YzNCCXJjsBCivA8xkzUzZH8dR`) on an unguessable
Railway URL with no real data. It can be suspended or destroyed at any time —
destroying it is also the natural test of the offboarding path.

## Launch blockers — engineering (no Doug action needed)

- [ ] **Deploy the control plane itself.** `apps/cloud` (Next.js app + its
      worker) has no production deployment target. Needs a Railway service pair
      in its own project, production env vars, and migrations gate — same
      pattern we impose on tenants. This is the largest single gap.
- [ ] **Control-plane email.** Signup OTPs currently surface in the dev log.
      Production needs a real sender (dogfood: Hogsend itself, or plain Resend).
- [ ] **Mint customer credentials.** The `mint-credentials` provision step is a
      recorded no-op (`credentialsMinted: false`); customers currently have no
      way to get their instance API keys. `HOGSEND_BOOTSTRAP_API_KEY` exists on
      the instance as the interim hook.
- [ ] **Stuck-provision reconciler** (PRD 10 slice). A provision that dies
      mid-pipeline parks a stack in `provisioning` forever; needs the sweep to
      reap/retry. We hit this repeatedly during live debugging.
- [ ] **Stripe wiring against test keys** (PRD 06 seam) — code is built to the
      seam; needs keys (see Doug list) then an end-to-end checkout proof.
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

- [ ] **Stripe**: create the products/prices (~$49 shared, $149 dedicated),
      hand over test-mode keys + price IDs; later flip to live keys.
- [ ] **DNS**: point `cloud.hogsend.com` at the control-plane Railway service
      (Cloudflare CNAME, same pattern as api.hogsend.com).
- [ ] **Production secrets**: bless a production Railway workspace token for
      the provisioner, plus a production `CLOUD_ENCRYPTION_SECRET` (both live
      only in Railway service vars, never in the repo).
- [ ] **Legal copy**: review/replace the Terms + Privacy stubs before real
      signups.
- [ ] **Pricing/limits sign-off**: confirm plan limits (events/emails per tier)
      the metering enforces.
- [ ] **Wave-end nod**: approve the PR from this worktree branch so the code
      reaches main and the release train (which also builds the default image
      per publish).
- [ ] Decide the proof tenant's fate: keep as staging canary, or destroy
      (recommended — exercises offboarding and stops the spend).

## Sequence to live

1. Doug: Stripe test keys + price IDs → engineering closes the billing seam.
2. Engineering: control-plane deploy + email + mint-credentials + reconciler.
3. Wave-end PR → Doug review → merge → release.
4. Doug: DNS + production secrets on the deployed control plane.
5. Private beta: a handful of hand-invited signups on test-mode Stripe.
6. Doug: legal copy + live Stripe keys → public.
