# Hogsend Cloud — the definitive guide to getting it going properly

Written 2026-07-29, the day the control plane went live. This is the plan of
record: what "properly" means, what stands between here and there, what only
Doug can decide, and the order to do it in. [GO-LIVE.md](GO-LIVE.md) is the
short checklist; [RUNBOOK.md](RUNBOOK.md) is how to operate it. This document is
the reasoning.

> **Partly historical as of 2026-08-04.** Several gaps it names have since been
> closed — credential minting is real, and instances are named on `hogsend.app`.
> For how the system works TODAY, read
> [HOW-IT-WORKS.md](HOW-IT-WORKS.md); where the two disagree, that one is newer.

---

## 1. Where we actually are

Deployed and working:

- **Control plane** on Railway (`hogsend-cloud`: app + worker + Postgres),
  reachable at an unguessable `*.up.railway.app` URL. Real signup email through
  Resend, live Stripe, its own Hatchet tenant on cell `us-1`.
- **The whole self-serve path**, proven twice end to end: sign up → verify by
  emailed code → create an organization → a managed instance is provisioned on
  shared infrastructure → it reports `healthy` (database, Redis, and a worker
  heartbeating through the cell's Hatchet).
- **A tenant instance is a real Hogsend**: engine API, worker, Redis, its own
  database, its own Hatchet namespace, and it even serves Studio at `/studio`.

Which makes the honest summary: **the hard part is done, and the product is not
yet usable by a stranger.** The gap is not infrastructure. It is this, verified
in the code today:

> A freshly provisioned tenant has **no administrator and no API key**.
> Provisioning explicitly disables the engine's own first-boot bootstrap
> (`HOGSEND_BOOTSTRAP_API_KEY: "false"`) because the control plane is supposed
> to mint credentials instead — and that step is still a recorded no-op. It
> never sets `STUDIO_ADMIN_EMAIL` either. So Studio answers "needs setup", the
> ingest API has no key to accept, and there is no network path to fix either.

The instance is healthy and **inert**. That, plus one reliability defect (§4)
that will strand a real signup, is the whole of Phase 0.

---

## 2. What "properly" means — the promise we are making

A person who has never met us should be able to:

1. Land on hogsend.com, sign in once, and **already be signed in** to Cloud.
2. Create an organization and get a running instance in a few minutes, with
   progress they can watch and understand.
3. Click **one button** and be inside their own Studio — no second password, no
   copy-pasted key, no "check your email" round trip.
4. Paste their Resend and PostHog keys and send a real message the same session.
5. Ship their own journeys with `hogsend publish` when they are ready.
6. Pay us, see what they are using, and leave with their data if they want to.

Every section below is a gap between that list and today.

---

## 3. Identity — one account, one click (the centrepiece)

### 3.1 The three islands we have today

There are three separate Better Auth instances, by deliberate design decisions
made at different times:

| Island | Cookie | Database | Sign-in methods |
|---|---|---|---|
| **hogsend.com + course.hogsend.com** | default prefix, `.hogsend.com` domain | one shared Postgres (the course owns the schema; docs is a sibling instance pointed at it) | email OTP, magic link, optional GitHub — **no passwords** |
| **Hogsend Cloud** | `hscloud.*`, host-only | the control-plane DB | email + password, email OTP, open sign-up |
| **A tenant instance** (engine + Studio) | `hogsend.*`, host-only | that tenant's own DB | email + password only, **sign-up disabled** |

Docs and course are genuinely one login: same signing secret, same database,
one cookie on the shared parent domain. That is real SSO, and it is the only SSO
we have.

The other two are isolated on purpose. A shared cookie NAME across different
databases is exactly what caused the old Studio login loop — the browser sends
the sibling cookie, it resolves against the wrong database, returns null, and
login never sticks. So the isolation is a correctness guard, not an oversight,
and any unification must go *through* a real handoff rather than around it by
sharing a cookie.

Worth knowing before we add a third consumer: the docs/course arrangement has no
tests asserting the shared secret or cookie domain, its duplicated schema is
kept in sync by a comment asking a human to keep it byte-identical, and the
shared-cookie path never runs locally (the domain is unset in dev). Adding Cloud
to that arrangement without hardening it would be building on sand — another
reason to federate rather than merge.

So "one click sign-in" is really **two** problems, and they have different
answers.

### 3.2 Problem A — hogsend.com ↔ Cloud (one Hogsend account)

Today someone who has an account on hogsend.com must create a *second*,
unrelated account on Cloud. That is the friction Doug is describing.

**Recommendation: make hogsend.com the identity provider, and Cloud an OIDC
client.** Better Auth already ships an `oidc-provider` plugin (present in the
version we run — no new dependency, no third-party IdP, no bill). Concretely:

- The docs/course auth server enables `oidcProvider` and registers Cloud as a
  first-party client (skip the consent screen — it is our own property). The
  plugin ships with the Better Auth version already installed; no new
  dependency, no third-party identity provider, no bill.
- Cloud keeps its own database, its own session, and its own `hscloud` cookie —
  nothing about the current isolation changes. It simply gains a **"Continue
  with Hogsend"** button that federates.
- On first federated sign-in Cloud creates its local user, linked by the IdP's
  stable subject id (not by email, which people change).
- Because the person is usually already signed in at hogsend.com, the round
  trip is invisible: click, redirect, back, signed in. That is the one click.

Why not the tempting alternative of pointing Cloud at the same user database
with a `.hogsend.com` cookie? Because Cloud's schema carries the organization
plugin and a different user shape, and because sharing one cookie across
different databases is the failure mode we already know. Federation gives the
same outcome without re-litigating that.

Keep email+password and email-OTP on Cloud regardless. Some customers will
never touch hogsend.com, and a hard dependency on the marketing site for
control-plane login is an availability risk we should not take. Note the
asymmetry to handle: hogsend.com is passwordless (OTP, magic link, GitHub) while
Cloud has passwords — so a federated user must never end up with a
password-shaped account they cannot recover.

**Decisions needed from Doug:** (a) is hogsend.com the IdP, or should Cloud be
(marketing sites usually shouldn't hold the keys to a control plane — but our
existing accounts live there); (b) do we also offer GitHub/Google directly on
Cloud, which many developer customers will expect.

### 3.3 Problem B — Cloud ↔ your instance's Studio (the button that matters)

This is the more valuable click, and it is completely missing — see the box in
§1. The good news is that the control plane already holds everything needed to
fix it, so **step one needs no engine change at all**.

Cloud stores, encrypted, each tenant's database DSN and its `BETTER_AUTH_SECRET`
(the instance's own session-signing key). The engine exports the same
`createAdminUser` primitive the CLI uses to mint a first admin directly against
a database. So `mint-credentials` can, today:

1. Create the customer's admin user on their instance (their email, a generated
   password) by calling that primitive against the tenant DSN.
2. Sign in as that admin over HTTP and mint an API key through the instance's
   own admin endpoint — which returns the full key exactly once.
3. Store the key encrypted, show it in the dashboard, and show the Studio
   password once with a prompt to change it.

That alone converts an inert instance into a working product: they can log into
Studio and they have a key to send events with. Ship it first.

**Then make it one click.** The interim ("here is your password") is honest but
not the promise. The real shape is a signed, single-use handoff: the **Open
Studio** button asks the control plane for a short-lived token, redirects to the
instance, and the instance exchanges it for a Studio session. Better Auth ships
a `one-time-token` plugin built for this; confirm the engine's pinned version
carries it before committing to that route, otherwise a small engine endpoint
guarded by a per-tenant handoff secret does the same job.

Security properties that are not optional, whichever route:

- The handoff endpoint verifies the caller's Cloud session **and** their
  membership of the organization that owns the stack, on every request — never
  a stored grant.
- The token is bound to one user and one stack, single-use, and short-lived.
- The shared secret is **per tenant**, never one global key.
- Removing someone from a Cloud organization must remove their instance access.
  Otherwise firing a teammate leaves them a working door — and because the
  instance has its own user table, that door does not close by itself.

Security notes that are not optional: the handoff endpoint must verify the
caller's Cloud session AND their membership of the organization that owns the
stack, per request (never trust a stored grant); the token must be bound to one
user and one stack; and revoking someone from the Cloud organization must
revoke their instance access too — otherwise removing a teammate leaves them a
working door.

### 3.4 Problem C — the CLI (already solved, keep it)

`hogsend login` uses a device-code flow with anti-phishing protections, sessions
hashed at rest, and tokens minted only at the single-use exchange. It is the
strongest identity surface we have. When the OIDC work lands, the device flow
should continue to authenticate against **Cloud**, not the IdP — one fewer hop
and it already works.

### 3.5 The end state, in one line

One Hogsend account signs you into the marketing site, the docs, the course, and
Cloud; from Cloud, one click drops you inside any instance you have rights to;
and the CLI holds a revocable session for the same identity.

---

## 4. Reliability — the defect that will strand a real customer

**Railway's API degrades badly for calls made from inside Railway.** Our
control-plane worker's provisioning bursts get persistent
`Problem processing request` 400s. We widened the retry budget from ~4 seconds
to ~63 and it still exhausted, parking the stack at `error`. The decisive test:
the identical pipeline, run from a laptop, completed every call.

So the fix is not longer inline retries. It is **a sweep that re-drives parked
provisions on a schedule**. Every step of the pipeline is idempotent and each
run demonstrably advances the stack, so re-driving converges. This must exist
before anyone we do not personally know signs up, because today the failure mode
is a customer sitting on a spinner forever while nothing retries.

Related and cheap, do them together:

- Surface provisioning progress honestly in the dashboard (which step, since
  when, and "we are retrying" rather than silence).
- Alert us when a stack has been non-`running` for more than N minutes. A
  control plane that fails quietly is worse than one that fails loudly.
- Consider pacing the provisioning mutations (a short delay between calls)
  since the burst is what trips Railway.

---

## 5. The first five minutes (onboarding)

Today the environment page shows topology, engine version, tenant database and
Hatchet namespace. That is an operator's view of infrastructure, not a
customer's view of their product. What it should show:

- **Open Studio** (§3.3) — the primary action. Today the URL is not even a
  clickable link; it is rendered as plain monospace text.
- Their instance URL, and a **working** copy-paste snippet: a real API key
  already filled in.
- Their API keys, with creation and revocation (this is the `mint-credentials`
  work again). The engine already has the right model — secret `hsk_` keys with
  scopes, and publishable `pk_` keys locked to `ingest-public` with a required
  browser-origin allowlist — so the dashboard just needs to expose it.
- A "send yourself a test message" button that proves the whole loop the moment
  their Resend key is saved.
- Progress and health in plain language.

The provider-keys page already validates keys against the provider before
storing them, which is the right instinct — keep that standard everywhere.

---

## 6. Shipping your own code (`hogsend publish`)

The CLI, the intake endpoint, the build pipeline, and the preflight gate all
exist. Two things block the loop end to end:

- **Registry credentials on deploy.** Tenant images are private; Railway needs
  credentials to pull them. Railway's service input has a `registryCredentials`
  field, so this is a small, known change.
- **A build host with Docker.** Builds shell out to a Docker daemon, which a
  Railway container does not have. Either run the build worker somewhere with a
  daemon, or use a remote builder. Decide before promising the feature.

Until both land, customers run the stock scaffold image, which is a perfectly
honest beta position — say so in the docs rather than letting them discover it.

---

## 7. Money

Stripe is wired with live keys and both prices exist; checkout reaches a real
hosted page; the webhook endpoint exists with its secret installed. What remains:

- Observe a **real subscription end to end** — checkout completed, webhook
  received, plan applied, and the same for a cancellation and a failed payment.
  None of that has been seen yet, and billing code that has never seen a live
  event is not proven.
- Decide and enforce **limits per tier** (events, emails, environments) with
  honest behaviour at the ceiling — warn, then throttle, never silently drop.
- The trial's end must do something specific and humane. Decide what.

---

## 8. Operating it

- **Kill switch**: suspend a stack for abuse or non-payment, and resume it. The
  substrate supports it; it needs an operator surface. Do not take money without
  this.
- **Fleet view**: every stack, its status, its cell, its plan, when it last
  looked healthy.
- **Cell capacity**: today one cell, `us-1`, capped at 100 tenants. Know the
  real ceiling (database connections and Hatchet throughput will bind long
  before 100) and how to add `us-2`.
- **Backups**: tenant databases live on the cell's Postgres. Confirm what is
  backed up, how to restore ONE tenant, and how often that is tested. This is
  currently unproven and it is the scariest gap on the list.
- **Status and support**: where does a customer look when their instance is
  down, and how do they reach us. Discord is a fine answer for beta if we say so.

---

## 9. Trust: data, deletion, legal

- **Export** and **destroy** from the dashboard (PRD 12). We should not take
  money before a customer can leave with their data.
- Terms and Privacy are stubs marked "draft" in the UI. Real copy before real
  signups.
- Note the operational landmine: `CLOUD_ENCRYPTION_SECRET` encrypts every stored
  provider key and cell DSN. It cannot be casually rotated once tenants exist.
  Decide now where it lives and who can read it.
- Deleting an organization must remove the Railway project, the tenant database,
  and the Hatchet tenant — not just the row.

---

## 10. The order to do it in

**Phase 0 — private beta (hand-invited, we watch every signup).**
Auto re-drive of parked provisions · **mint credentials** (admin + API key, the
zero-engine-change route in §3.3) · Studio link and a working snippet on the
environment page · suspend switch. These four turn an inert instance into a
product, and with them the Discord invite is honest. This is the smallest
truthful launch.

**Phase 1 — public beta (a stranger can self-serve).**
One-click sign-in from hogsend.com (§3.2) and one-click into Studio (§3.3) · a
real Stripe subscription observed end to end · limits enforced · export and
destroy · real legal copy · `cloud.hogsend.com` · restore-one-tenant tested.

**Phase 2 — general availability.**
`hogsend publish` fully closed (registry credentials + build host) · staging and
test environments · fleet console and alerting · a second cell · dedicated tier
and EU region.

---

## 11. What only Doug can decide

1. **Identity**: is hogsend.com the identity provider for Cloud? Add GitHub or
   Google on Cloud directly?
2. **Beta shape**: how many invites, and how are they handed out in Discord?
3. **Limits per tier** — the actual numbers metering will enforce.
4. **What happens when a trial ends**, and when a payment fails for good.
5. **Support promise** for paying customers — response time, channel, hours.
6. **Legal copy** — write it or buy it.
7. **The two throwaway tenants** — keep one as a canary, or destroy both.
8. **The wave-end PR** — approve so all of this reaches main.

---

## 12. The one-paragraph version

The infrastructure works: people can sign up and get a real, healthy, managed
Hogsend today. Before strangers should touch it, two things must be true — a
failed provision must retry itself instead of stranding someone, and a finished
provision must hand the customer a way into their own instance. That is Phase 0
and it is small. Everything after it is the difference between a working system
and a business: one account across all of Hogsend, money that has actually moved
end to end, a switch to turn abuse off, and a door customers can walk out of
with their data.
