# Hogsend Cloud — how it all works

What the control plane is, what it does to bring a customer's instance into
existence, and where to look when something is wrong.

Read this one to understand the machine. [RUNBOOK.md](RUNBOOK.md) is the
symptom-to-cause table for when it misbehaves. [GUIDE.md](GUIDE.md) was the
plan of record written the day it went live and is now partly historical —
where the two disagree, this document is newer.

---

## 1. The shape

Two kinds of thing, and keeping them apart explains almost everything else.

**The control plane** is one Next.js app plus one worker, at
`cloud.hogsend.com`. It owns accounts, organizations, billing, and the
machinery that creates and destroys customer infrastructure. It is a single
shared application: every customer is a row in its database.

**A tenant instance** is a whole Hogsend, per customer, per environment: its
own API, its own worker, its own Postgres database, its own Redis, its own
Hatchet namespace, and Studio served at `/studio`. It runs the customer's own
code once they publish. Nothing is shared with another tenant except the
physical cell it is placed on.

So the control plane is multi-tenant; the product is not. That is deliberate —
a customer's journeys are their code, running in their own instance.

```
cloud.hogsend.com  (control plane: app + worker + postgres)
   │
   │  provisions, deploys, suspends, destroys
   ▼
acme.hogsend.app   (tenant: api + worker + redis + db + hatchet namespace)
```

### Where things live

| Thing | Where |
|---|---|
| Control plane code | `apps/cloud` |
| Control plane infra | Railway project `hogsend-cloud` (`cloud-app`, `cloud-worker`, `cloud-postgres`) |
| Tenant infra | Railway project per org, named `hs-org-<id>` |
| Tenant hostnames | Cloudflare zone `hogsend.app` |
| Marketing, docs, control plane hostname | Cloudflare zone `hogsend.com` |
| Tenant images | `ghcr.io/dougwithseismic/hogsend-env-<envId>:<buildId>` |
| Control plane image | `ghcr.io/dougwithseismic/hogsend-cloud:launch-N` |

---

## 2. The two seams

Every piece of infrastructure work goes through one of two interfaces. This is
the single most important structural fact about the codebase: business logic
never sees a Railway type, a GraphQL id, or a Cloudflare payload.

### `SubstrateProvider` — `src/substrate/types.ts`

"Where does this instance run." Provision, set env, deploy an image, attach a
domain, read health, suspend, resume, destroy.

Two implementations: `RailwaySubstrate` (real) and `FakeSubstrate`
(in-memory). Both must pass `describeSubstrateContract` — the contract suite
is the real definition of the seam, and it is what makes the fake a safe
stand-in for every other test in the control plane.

### `DnsProvider` — `src/dns/types.ts`

"What name points at it." Three methods: `ensureRecord`, `deleteRecord`,
`readCapacity`. Same arrangement — `CloudflareDns` and `FakeDns`, both held to
`describeDnsContract`.

It is a separate seam rather than another substrate method because DNS is a
different vendor with different credentials, rate limits and failure modes, and
the pipeline has to tell a retryable failure from a permanent one for each
independently.

**The rule both seams share:** vendor identifiers live inside opaque handles
(`StackRefs.data`, `DnsRecordHandle.id`) that callers store and hand back and
never parse. A second vendor should need no migration.

**Fakes must be honest.** A fake that is merely permissive lets a bug pass
every test and surface in production. `FakeDns` enforces the same conflict
refusal the real one does; `FakeSubstrate.attachDomain` returns BOTH records a
real substrate demands, because a fake that returned one would have hidden a
real bug we shipped and had to fix.

---

## 3. Provisioning: how an instance is born

`src/pipeline/provision.ts`, one named step at a time. Triggered automatically
when an organization or environment is created — no operator step.

| Step | What it does |
|---|---|
| `start` | Transition the stack to `provisioning` |
| `ensure-tenant-db` | Create the tenant's database and role on the cell |
| `mint-hatchet` | Mint the tenant's Hatchet token and namespace |
| `substrate-provision` | Create the Railway project and its api/worker/redis services |
| `ensure-hostname` | Give it a name on `hogsend.app` (see §4) |
| `set-env` | Assemble and push the environment — **this freezes the URL** |
| `health-wait` | Poll until the instance answers healthy |
| `mint-credentials` | Create the Studio admin and the tenant's first API key |
| `finish` | Transition to `running`, send the welcome email |

### The four laws this pipeline obeys

1. **Every step is idempotent, and proves it from PERSISTED state.** A step
   that already ran left an artifact on the stack row — an encrypted DSN, a
   Hatchet token, `substrate_refs` — and re-running SKIPS it by finding that
   artifact. This is what makes a retry "resume from the failed step" rather
   than "start again". The pipeline has no memory of its own, only the row's.
2. **Status is never written here.** Every transition goes through
   `StackService`, the sole legal writer, so the legal-edge table and the audit
   row cannot come apart.
3. **A failure parks the stack.** Any step that throws is recorded via
   `recordError` — status `error`, `last_error` naming the STEP, `retry_count`
   incremented — and the pipeline returns rather than throwing, because its
   callers are a durable task and a fire-and-forget queue.
4. **Nothing logs a secret.** DSNs, Hatchet tokens, auth secrets and provider
   keys travel from their store to `setEnv` and are never stringified into a
   log line, an audit detail, or an error message.

---

## 4. Hostnames, and why they are on a different domain

A new instance is born at `<org-slug>.hogsend.app`. Production is bare;
every other environment is suffixed — `acme-staging.hogsend.app`.

### Why `hogsend.app` and not `hogsend.com`

This is a security decision, not a branding one.

`apps/docs` and `apps/course` share an SSO session cookie set with
`Domain=.hogsend.com`. Cookie domain-matching is **suffix-based with no depth
limit**, so that cookie is sent to every host under `hogsend.com` at every
depth — `acme.hogsend.com` and `acme.cloud.hogsend.com` alike. A tenant
instance runs the customer's own code. Putting tenants anywhere under
`hogsend.com` hands our session cookie to code a customer controls, on every
request.

A different registrable domain is the only thing that stops it. Every
instance-per-tenant platform makes this same split — Vercel (`vercel.app`),
Railway (`up.railway.app`), Netlify, Render, Fly, Heroku, Supabase — and all of
them additionally list that domain on the Public Suffix List.

`refuseTenantZone` in `src/lib/hostnames.ts` makes it structural: a tenant zone
equal to or inside the SSO cookie domain is refused at the point of use, so a
misconfiguration cannot quietly reintroduce the leak.

### Why the step sits where it does

`ensure-hostname` runs **between `substrate-provision` and `set-env`**, and the
position is the whole design. `set-env` freezes `API_PUBLIC_URL` and
`BETTER_AUTH_URL`, and those two mint every tracked email link, every SMS short
link, every unsubscribe URL, and sign the Studio cookie. An instance that
learns its name before that point never knew another one — so new instances
need no migration off a Railway URL.

### Two records, not one

A custom domain needs a **CNAME** to route it and an **ownership TXT** to prove
it. Railway returns 404 for a custom domain whose TXT is missing, permanently,
even after the CNAME resolves. So the step attaches to the substrate FIRST and
publishes verbatim whatever records it is handed — never a CNAME it computed
itself.

Budget **two Cloudflare records per instance**. A free zone holds 200, so
`hogsend.app` seats about 100 instances.

### It skips rather than fails

A DNS outage, an unusable org slug, a missing zone — all SKIP the step and
leave the instance on the substrate's own URL, which is where every stack
provisioned before this existed already lives. A hostname is an improvement to
provisioning, not a precondition for it. Failing a signup over a DNS blip would
be the wrong trade.

### Org slugs

The slug is Better Auth's, minted once at organization creation and never
changed — the hostname is baked into sent email and signed cookies, so it must
not move. `slugifyOrgName` holds it to hostname rules and a reserved list, so a
tenant called "Docs" gets `docs-a1b2c3` rather than shadowing a host we serve.

---

## 5. Publishing, and rolling back

### Publish

`hogsend publish` from the customer's repo uploads a tarball; the build
pipeline (`src/pipeline/build.ts`) builds an image, runs a preflight gate,
pushes it to GHCR, and deploys it — **worker first, api second**. The worker
takes no inbound traffic, so a broken image is discovered there rather than in
front of customers, and the migration runs as the worker's pre-deploy command.

`builds.status = succeeded` asserts exactly this: the image was built, passed
the gate, reached the registry, and both rollouts were accepted. Whether the
containers then STAYED up is an observation, and it belongs to the health sweep.

One build runs at a time per environment, enforced by a partial unique index —
a publish sent while another is in flight waits its turn.

### Rollback

`src/pipeline/rollback.ts` re-deploys a previous build's image, reusing the
same deploy shape. Image references are deterministic, so any past build is
reconstructible from its row.

**It does not undo database migrations.** They are forward-only: a column the
rolled-away build added is still there afterwards. Someone whose new code was
merely wrong gets what they want; someone whose new code DROPPED something does
not get it back. The UI says so on the control rather than behind a dialog.

Guards: only a succeeded build, only one belonging to that environment, only
onto a running stack, and a failed rollout hands the stack back to `running` so
the outage does not outlive the mistake.

---

## 6. Lifecycle

`src/pipeline/lifecycle.ts`.

- **Suspend** stops the substrate services. Data and every credential are kept;
  resume brings the same stack back.
- **Destroy** runs `release-hostname` (delete our DNS records first, so no name
  is left pointing at a dead service) → `substrate-destroy` → `drop-tenant-db`
  → `clear-secrets` → `finish`. Only `suspended` and `error` stacks may be
  destroyed, enforced by the transition table rather than an `if`.

Suspend and resume call the substrate BEFORE the transition, because there is
no "suspending" state to fail into. Destroy is the exception: `destroying` is a
real state, so it transitions first and parks in `error` on failure, from which
a retry resumes.

---

## 7. Health, alerts, metering

- **Health sweep** (`pipeline/health-poll.ts`) reads every running stack every
  minute and records a boolean plus a reason. Three consecutive unhealthy reads
  raise a dashboard alert. The poll never transitions a stack — an alerting
  environment is still `running`, and the UI says so rather than implying an
  outage was acted on.
- **Metering** writes `usage_counters` (events and emails, per environment, per
  UTC month) from a **cron at 03:00 UTC**. This matters for anything reading
  those counters: they are up to a day stale by design. The onboarding
  checklist labels those steps "Counted daily" for exactly this reason.
- **Billing** is Stripe, with a 14-day trial and a dunning grace measured from
  the first failed payment.

---

## 8. The environment page

`app/environments/[id]/page.tsx`. A short overview — status, health, a
first-run checklist — over four rows that open right-hand drawers:
**Networking**, **Keys and access**, **Builds**, **Operations**. Everything
technical (topology, engine version, tenant database name, Hatchet namespace,
the raw provisioning trail) sits behind `Advanced details`.

Drawers are the native `<dialog>` with `showModal()`, so the focus trap, the
Escape key, the inert background and top-layer stacking come from the browser.

Each closed row carries the answer most visits want, so the common question
never needs a click.

**Secrets** (Studio password, `.env` snippet) are never in the server-rendered
HTML. They exist only as the return value of an explicitly clicked server
action, and a fresh render returns to the hidden state. The mask toggle is a
VIEW control, not a security boundary — once revealed, the value is in the DOM
either way.

---

## 9. Releasing the control plane

**This does not happen on merge.** `cloud-app` deploys from a pinned Docker
image, not from the repository, so a merge to `main` releases nothing. The
`watchPatterns` in `railway.cloud.toml` never fire for it.

To release:

```bash
gh auth token | docker login ghcr.io -u <you> --password-stdin
docker buildx build --platform linux/amd64 -f Dockerfile.cloud \
  -t ghcr.io/dougwithseismic/hogsend-cloud:launch-<N+1> --push .
```

Then point the service at the new tag — Railway dashboard → `cloud-app` →
Settings → Source Image → edit → Deploy.

**Do not use redeploy.** `serviceInstanceRedeploy` replays the previous
deployment's recorded manifest, image included, so a tag change has no effect.
Always verify the ACTIVE DEPLOYMENT's image rather than the source field before
believing a release landed.

---

## 10. Configuration

The variables with no safe default, on `cloud-app`:

| Variable | Purpose |
|---|---|
| `CLOUD_SUBSTRATE` | `railway` or `fake`. Production must choose; there is no default. |
| `CLOUD_RAILWAY_TOKEN` | Workspace token. `getSubstrate()` refuses to build a Railway substrate without it — a missing token never falls back to the fake. |
| `CLOUD_DNS` | `cloudflare` or `fake`. |
| `CLOUD_CLOUDFLARE_TOKEN` | Zone-scoped, DNS edit, on `hogsend.app` ONLY. |
| `CLOUD_CLOUDFLARE_ZONE_ID` / `_ZONE_NAME` | The zone being written. |
| `CLOUD_TENANT_ZONE` | **The switch.** Absent → `ensure-hostname` skips and instances keep their substrate URL. Present → instances are named under it. |
| `CLOUD_SSO_COOKIE_DOMAIN` | Never used to SET a cookie. It is what the tenant-zone guard checks against. |

Fail-closed behaviour worth knowing: `CLOUD_DNS="fake"` together with a zone
name in production is REFUSED at boot. That combination would give instances
hostnames that resolve nowhere, and because the URL mints tracked links, the
damage would be silent until a customer's mail went out with dead links in it.

---

## 11. Where to look when something is wrong

| Symptom | Look at |
|---|---|
| Signup stuck / instance never ready | `stacks.last_error` names the failed STEP; the provisioning trail is under Advanced details |
| Instance running but inert | `mint-credentials` — Studio admin and the first API key |
| Hostname missing, instance on a Railway URL | `ensure-hostname` skipped: check `CLOUD_TENANT_ZONE`, the org slug, and the audit row's reason |
| Hostname present but 404 | The ownership TXT. A CNAME alone never verifies. |
| A publish did nothing | Check the ACTIVE deployment's image, not the source field |
| Counters look stale | They are. 03:00 UTC cron. |
| Everything healthy but a customer sees nothing | The health sweep tests the instance, not the customer's journeys |

More symptom-to-cause pairs, including the hard-won Railway ones, are in
[RUNBOOK.md](RUNBOOK.md).
