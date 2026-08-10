# Hogsend Email — locked decisions

Settled before any code. Every PRD inherits this file. Do not re-litigate an entry here inside a
PRD; if one turns out to be wrong, change it HERE and note the change, so the whole stack moves
together.

---

## 1. What this is

**Hogsend Email** is a first-party email sending wire for Hogsend Cloud, backed by an AWS SES
account we own. A Cloud tenant provisions, verifies a domain with one DNS record, and sends. They
never create a Resend account, never paste an API key.

### What it is NOT

- **Not a Resend replacement.** The BYO provider seam is load-bearing product surface. Resend stays
  the default for self-hosted deploys and stays fully supported on Cloud. Postmark stays supported.
  Hogsend Email is an ADDITIONAL registry entry, never a removal.
- **Not a standalone email API.** No public signup, no separate pricing page, no docs page selling
  it as an ESP. Cloud is the only issuer of relay tokens and the only documented path.

The reason is abuse economics, and it is the single most important control in this whole stack: a
population of "people who bought a lifecycle engine and provisioned a stack" has a near-zero spammer
rate. A population of "anyone with a credit card who wants to send email" does not. Same code,
different company. We are choosing the first one deliberately.

Locked 2026-08-10 with the user: **Cloud-only, but no hard coupling.** The plugin takes a relay URL
and a tenant token, both plain config. Nothing in the code prevents a future standalone offering;
nothing invites one.

---

## 2. Settled research (do not re-derive)

Verified live on 2026-08-10. Cited so a future reader can re-check rather than re-discover.

- **Resend is an SES wrapper.** `send.resend.com` MX = `feedback-smtp.us-east-1.amazonses.com`,
  SPF = `v=spf1 include:amazonses.com ~all`. Identical shape on `send.cal.com`,
  `send.gumroad.com`, and our own `send.hogsend.com` (eu-west-1). Resend signs DKIM with **1024-bit**
  RSA. We use 2048.
- **SES Tenants** (launched Aug 2025) is the isolation primitive: up to 10,000 tenants per account
  (300k on request), per-tenant reputation metrics, reputation policies (`Standard` / `Strict` /
  `None`) that auto-pause ONE tenant without touching the account, tenant-level suppression lists
  (`SuppressionScope: TENANT`), EventBridge events for status changes and findings, and AWS Trust &
  Safety enforcing per-tenant rather than per-account.
- **BYODKIM verifies a domain with ONE TXT record**, versus Easy DKIM's three CNAMEs. Skipping the
  custom MAIL FROM leaves the return path as a subdomain of `amazonses.com`; SPF passes natively for
  SES and DMARC passes on DKIM alignment.
- **Custom MAIL FROM must be a subdomain of the verified identity's parent domain.** We CANNOT route
  customer bounces through a Hogsend-owned domain. The branded return path is therefore always
  `send.<customer-domain>`, exactly like Resend's.
- **Cost:** $0.10/1k sending + $0.005/1k tenant management + $0.005/tenant/month. Roughly $0.105 per
  thousand all in.
- **The caveat we must respect,** in AWS's own words: tenants' "combined sending activity still
  affects your overall account reputation. Tenants that develop poor sending practices could put
  your entire account at risk." Tenant isolation bounds the blast radius. It does not remove it.
  Every enforcement decision in PRD 08 assumes we still care about the aggregate.

---

## 3. Architecture

### 3.1 The seam we are implementing into (already exists — do not rebuild)

Scouted 2026-08-10. This is why the stack is smaller than it looks:

| Existing surface | Location | What it means for us |
| --- | --- | --- |
| `EmailProvider` contract, `defineEmailProvider()` | `packages/core/src/providers/email.ts` | The provider is a DUMB wire. HTML-only `send`/`sendBatch`, neutral `EmailEvent` webhooks. Engine already owns render, tracking, preferences, `email_sends`. |
| `DomainsCapability` | `packages/core/src/providers/domains.ts` | Provider-neutral `DnsRecord` / `DomainStatus`. **Presence is the gate.** Implement it and the admin routes, `hogsend domain` CLI, and Studio Setup light up with no new UI. |
| CLI `dns-apply` | `packages/cli/src` | Already writes DNS records via the Cloudflare and Vercel APIs. **The one-click DNS write is already built.** |
| `emailProvidersFromEnv` + `loadOptionalPlugin` | `packages/engine/src/lib/email-providers-from-env.ts` | The opt-in-package idiom: guarded dynamic import with a runtime-assembled specifier so `tsc` never resolves an uninstalled optional package. Copy it exactly. |
| `contract.ts` + real + `fake.ts` | `apps/cloud/src/substrate/`, `apps/cloud/src/images/`, `apps/cloud/src/billing/` | The house seam idiom. Every external service is an interface with a deterministic Fake. SES is no different. |
| `provider_keys` | `apps/cloud/src/db/schema/provider-keys.ts` | AES-256-GCM under `CLOUD_ENCRYPTION_SECRET`, one row per (environment, provider). The DKIM private key lives here. Do not invent a second secret store. |
| `usage_counters` | `apps/cloud/src/db/schema/usage-counters.ts` | Already carries `emailsCount`, already upserts on `(environment_id, month)`. The allowance meter has a sink; PRD 09 adds the source and the enforcement. |
| Billing contract | `apps/cloud/src/billing/{types,stripe,fake}.ts` | Stripe is already wired behind a contract with a Fake. Overage rides it. |
| `pipeline/provision.ts` | `apps/cloud/src/pipeline/` | Where the SES tenant gets created. |

### 3.2 Unit of tenancy

**One SES tenant per Cloud `environment`.** Not per organization. `environments` is the row that
owns a stack, a database, and a set of `provider_keys`, so it is the only boundary where "this
tenant's reputation" is a coherent statement.

SES tenant name: `env-<environmentId>`. Stable, opaque, no customer-controlled string in an AWS
resource name.

### 3.3 Region

Derived, never separately configured. `SubstrateRegion` already exists on the stack:

| `SubstrateRegion` | SES region |
| --- | --- |
| `us` | `us-east-1` |
| `eu` | `eu-west-1` |

SES tenants are region-scoped and do not replicate, so an environment's SES tenant is minted in
exactly one region and pinned there for its life. Changing an environment's region is out of scope
for this wave; if it ever ships it is a re-verify-your-domain migration, not a config flip.

### 3.4 Topology → IP strategy

| `SubstrateTopology` | IP posture |
| --- | --- |
| `shared` | SES shared pool. No dedicated IP. Correct at any volume we will see this year. |
| `dedicated` | Eligible for an SES managed dedicated IP pool, provisioned **manually on request**, not automatically. |

Automatic dedicated-IP provisioning is explicitly deferred. A dedicated IP with no warmup and low
volume has WORSE deliverability than the shared pool, so making it automatic would be an
anti-feature.

### 3.5 Data flow

```
journey / broadcast
  → engine tracked mailer  (render, preferences, tracking, email_sends)  [unchanged]
  → EmailProvider "hogsend"  (packages/plugin-hogsend — dumb wire, HTML only)
  → POST apps/cloud /v1/email/send   (tenant token auth, idempotent)
  → SesClient.sendEmail({ TenantName, ConfigurationSetName, ... })       [apps/cloud/src/ses]
  → AWS SES

AWS SES → SNS/EventBridge → apps/cloud → tenant instance webhook
  → POST /v1/webhooks/email/hogsend → provider.verifyWebhook/parseWebhook → EmailEvent
  → engine emailService.handleWebhook   [unchanged]
```

**AWS credentials never leave the control plane.** A tenant instance holds a relay token, nothing
more. This is why the relay exists at all rather than handing each instance scoped IAM creds.

### 3.6 Provider capabilities

```ts
capabilities: {
  nativeTracking: false,   // first-party tracking is sovereign; SES native tracking stays OFF
  scheduledSend: false,    // use ctx.sleepUntil — durable, visible, cancellable
  signedWebhooks: true,    // relay signs; the plugin fails closed without the secret
}
```

`scheduledSend: false` is deliberate. SES does not offer it, and the engine already has a strictly
better answer in `ctx.sleepUntil`.

---

## 4. Quality gates

Verbatim, into every delivery-agent brief. Run from the repo root.

Measured on this machine 2026-08-10 against clean `origin/main`, not guessed.

**Full gate set — run at PRD completion, not after every task:**

```bash
pnpm turbo run check-types --concurrency=2   # 70s cold (5/51 cached); ~15-25s incremental
pnpm lint                                    # 1.4s — biome check . at the ROOT
pnpm turbo run test --concurrency=1          # see the concurrency note below
pnpm turbo run build --concurrency=2
```

**Per-task gate — run after every task, scoped to the task's `_Boundary:_`:**

```bash
pnpm --filter <workspace> test
pnpm turbo run check-types --concurrency=2   # incremental, cheap
pnpm lint
```

Three corrections found by actually running these:

1. **`lint` is NOT a turbo task.** `pnpm turbo run lint` fails with "Could not find task `lint` in
   project". The root script is `biome check .` and it takes 1.4 seconds across 2314 files. Use
   `pnpm lint`.
2. **`pnpm turbo run test --concurrency=2` FAILS on clean main**, and it is not a real break.
   `@hogsend/api` (2466 tests) and `@hogsend/cloud` (1010 tests) each pass alone and fail when run
   concurrently — the combined run pulls `user 516s` into 93s wall. **A loop that treats this as a
   real failure will burn a revision round per task chasing a phantom; a loop that learns to ignore
   red gates is worse.**

   **RESOLVED 2026-08-10 by measurement, not by tuning.** `--concurrency=1` is green on clean main:
   47/47 turbo tasks successful in **2m14s** wall (45 cached), `@hogsend/api` 236 files / 2459 passed
   / 7 skipped. Two minutes for the full-repo test gate is cheap enough that chasing the concurrent
   run's resource contention buys nothing. `--concurrency=1` IS the test gate. Do not "fix" this.

   Note for readers of test output: `@hogsend/api` logs a red `[ERROR/Admin] /WorkflowService/
   TriggerWorkflow UNAVAILABLE ... wrong version number` line during the run. That is a test
   deliberately exercising the no-Hatchet path, the suite passes, and it is not a failure.
3. **`--concurrency=2` stays for check-types and build.** Turbo fan-out OOMs in this repo and exits
   137, which reads as a type error and is not one.

Additional, non-negotiable:

- **TDD.** Failing test first, then green. A test that passes before the implementation is a
  vacuous green and must be mutation-checked: break the guard, watch the test fail, restore.
- **Every external call goes through a Fake in tests.** No test in this stack may reach AWS.
- **No test may send a real email.** `HOGSEND_TEST_MODE` only redirects; a real key is a real
  delivery.

---

## 5. Conventions

- Conventional Commits, kebab-case scope, header ≤100 chars. One commit per task.
- Biome. 2-space, double quotes, semicolons, 80 cols.
- ESM, `.js` extensions on relative imports.
- `pnpm add <pkg>@latest` — never hand-edit a version into `package.json`.
- Any new engine dependency must be mirrored into the `create-hogsend` template `_package.json`,
  or a fresh scaffold breaks at boot.
- Work in `.claude/worktrees/<slug>`, never the main checkout.
- **Publish mode: `local-commits-only`.** No pushes, no branches, no PRs, no deploys during BUILD.
- Never mention any AI tool or vendor in a commit message. Never add a `Co-Authored-By` trailer.

---

## 6. Product decisions locked with the user (2026-08-10)

| Question | Decision | Consequence |
| --- | --- | --- |
| Rollout | **New provisions default to Hogsend Email. There are no existing Cloud tenants**, so there is no migration. BYO Resend/Postmark stays available to any tenant that wants it. | No migration PRD. No dual-provider transition. |
| Billing | **Included plan allowance + metered overage** via Stripe usage records. | PRD 09 exists and is real work, not a counter. |
| Paused tenant | **Fail closed, loudly, no fallback.** Sends fail with an explicit paused status, surfaced in Studio and the API; journeys record the reason. Nothing is silently rerouted, and a tenant AWS flagged for abuse does NOT get an escape hatch through their own BYO key. | PRD 03 checks status before send. PRD 08 owns the state. |
| Standalone | **Cloud-only, no hard coupling.** | Relay URL + token are config. No public signup surface anywhere in this stack. |

## 7. Open seams (human input required, tracked not blocking)

These block LAUNCH, not BUILD. Every one of them has an in-repo path that ships against a Fake.

1. **SES production access as an ESP.** A support request describing a multi-tenant sending model.
   This is the long pole and PRD 01 starts it first.
2. ~~**AWS account + IAM for the control plane.**~~ **RESOLVED 2026-08-10, see §7.1 below.** The
   structure is decided; only its *execution* in the AWS console is the user's.
3. **The Acceptable Use Policy and the ToS clause.** Product/legal judgment, PRD 01 drafts, user
   approves.
4. **Dedicated IP pool purchase**, if and when a `dedicated`-topology tenant asks.

### 7.1 AWS account structure and control-plane IAM (resolved — PRD 01 task 1)

**A dedicated AWS member account, `hogsend-email-prod`.** Not a shared account, not one account per
tenant.

The reason is that the three things that matter here — production access, the sending quota, and
account-level reputation — are all **account-scoped**. Putting them in their own account means a
reputation event can never reach unrelated infrastructure, and a leaked credential can do exactly one
thing: send email. Account-per-tenant is the other failure mode: it needs a separate production-access
ticket per customer, which does not scale and which AWS would reasonably question. SES Tenants exists
precisely so one account is safe for this.

**Control-plane authentication: a static IAM access key, narrowly scoped.** `apps/cloud` runs on
Railway, which is not AWS compute, so there is no instance role to assume and Railway does not
federate OIDC to AWS. The honest answer is an IAM user (`hogsend-cloud-relay`) holding one
customer-managed policy, with its key in the control plane's environment and a rotation reminder. No
`sts:AssumeRole` indirection — it would add a hop without removing the static secret that makes the
hop possible.

**The policy grants only the sixteen verbs of PRD 02 and nothing else.** No `ses:*`. The action list
is derived from the verb table in PRD 02 §Locked decisions and is written out in PRD 01 task 2's
deliverable. **The exact IAM action names for the Tenants and Reputation-Entity APIs must be
confirmed against the live AWS SES IAM reference before the policy is written** — those APIs shipped
in August 2025 and an action name guessed from the SDK method name produces an `AccessDenied` at
provision time rather than at deploy time, which is the worst place to find it.

**Env vars** (`apps/cloud/src/env.ts`, PRD 01 task 5), all optional:

| Var | Meaning |
| --- | --- |
| `CLOUD_AWS_ACCESS_KEY_ID` | Control-plane IAM user key. Absent ⇒ Hogsend Email inactive. |
| `CLOUD_AWS_SECRET_ACCESS_KEY` | Its secret. |

Both absent is the supported default: the control plane boots normally, the SES factory yields the
Fake, and one log line names which client is active. This mirrors what the engine already does for a
missing `RESEND_API_KEY` and is the posture PRD 02's last acceptance criterion requires. Presence of
**both** is the gate; exactly one set is a misconfiguration and must fail loudly at boot rather than
silently degrading to the Fake in production.

## 8. Deferred (named so they are not silently forgotten)

- Automatic dedicated IP provisioning and warmup (§3.4).
- Cross-region tenant migration (§3.3).
- Inbound/receiving email on SES.
- Standalone/public signup (§1).
- Bulk list import on the shared pool for untrusted tenants (PRD 08 blocks it; lifting the block is
  future work with its own review).
</content>
</invoke>
