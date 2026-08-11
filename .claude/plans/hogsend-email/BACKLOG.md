# Hogsend Email — backlog

Ordered queue. Read [DECISIONS.md](DECISIONS.md) first; it is settled and inherited by every PRD.

**Status legend:** `[ ]` not started · `[~]` shipped to a seam (in-repo path done, external ask
enumerated) · `[x]` done.

| # | PRD | Status | Depends | Scope |
| --- | --- | --- | --- | --- |
| 01 | [SES access and abuse policy](prds/01-ses-access-and-policy.md) | `[~]` | — | The long pole. AWS account structure, ESP production-access request, Acceptable Use Policy, ToS clause. Mostly non-code; start it first because it is calendar time, not engineering time. |
| 02 | [SES client seam](prds/02-ses-client-seam.md) | `[x]` | — | `apps/cloud/src/ses/`: a `SesClient` contract, an `aws.ts` implementation over `@aws-sdk/client-sesv2`, and a deterministic `fake.ts`. Every later PRD tests against the Fake and nothing in this stack ever reaches AWS in CI. |
| 03 | [Send relay](prds/03-send-relay.md) | `[x]` | 02 | `POST /api/email/send` and `/send-batch` on `apps/cloud`: tenant-token auth, per-item idempotency, per-environment burst rate limit, paused-tenant fail-closed, allowance gate, neutral options → `SendEmail` with `TenantName` + `ConfigurationSetName`. |
| 04 | [packages/plugin-hogsend](prds/04-plugin-hogsend.md) | `[x]` | 03 | The `EmailProvider` itself. HTML-only `send`/`sendBatch` over the relay, `capabilities` per DECISIONS §3.6, signed `verifyWebhook`/`parseWebhook` → `EmailEvent`. An opt-in package, mirroring plugin-postmark. |
| 05 | [Email event ingress](prds/05-email-event-ingress.md) | `[x]` | 02, 04 | SES → SNS → control plane → tenant instance. Normalize Bounce/Complaint/Delivery/DeliveryDelay into `EmailEvent`, verify SNS signatures, route per tenant, sign the outbound hop. |
| 06 | [SES tenant provisioning](prds/06-tenant-provisioning.md) | `[x]` | 02 | Hook `pipeline/provision.ts`: create the SES tenant + configuration set, set `SuppressionScope: TENANT`, start on reputation policy `None`, mint and inject the relay token. Idempotent, resumable, cleaned up on teardown. |
| 07 | [Domains capability](prds/07-domains-capability.md) | `[x]` | 02, 06 | Implement the EXISTING `DomainsCapability` for Hogsend Email: 2048-bit BYODKIM keypair, `CreateEmailIdentity`, **one TXT record**, polling to verified, plus the advanced branded-return-path toggle that adds MX + SPF. Lights up the admin routes, `hogsend domain`, Studio Setup, and CLI `dns-apply` with no new UI. |
| 08 | [Abuse enforcement](prds/08-abuse-enforcement.md) | `[x]` | 02, 03, 06 | EventBridge (`Sending Status Disabled`, `Advisor Recommendation Status Open`) → control plane → tenant state → customer notification → Studio surface → appeals. Trust tiers, ramped caps, bulk-import block. Promotion from reputation policy `None` to `Standard`. |
| 09 | [Allowance and metered overage](prds/09-allowance-and-overage.md) | `[x]` | 03, 06 | Feed `usage_counters.emailsCount` from the relay, enforce the plan allowance as a hard cap, report overage to Stripe through the existing billing contract, reconcile. |
| 10 | [Env preset and consumer wiring](prds/10-env-preset-and-wiring.md) | `[x]` | 04, 06 | `emailProvidersFromEnv` gains a `hogsend` preset behind the guarded dynamic import; provisioner injects the env; `create-hogsend` template and docs updated. The last mile that makes a fresh Cloud instance send with no `RESEND_API_KEY`. |

## Wave 2 — verification and debt (queued 2026-08-11)

Wave 1 shipped 433 tests over the email surface, **none of which have sent a byte to AWS**. Wave 2 is
about closing the gap between "the suite is green" and "we know this works", plus the one design debt
wave 1 knowingly took.

| # | PRD | Status | Depends | Scope |
| --- | --- | --- | --- | --- |
| 11 | [Live SES contract walkthrough](prds/11-live-ses-contract-walkthrough.md) | `[~]` | 02, 06, 07 | One human-run script that walks the real provisioning path against a real AWS account and diffs every answer against `FakeSesClient`. Runs in SES **sandbox**, so it is unblocked the day the account exists rather than after production access. The divergences are the deliverable. |
| 12 | [Scaffold verify covers plugin-hogsend](prds/12-scaffold-verify-hogsend-plugin.md) | `[~]` | 10 | Extend the scaffold smoke's step 7b to actually load `@hogsend/plugin-hogsend` under plain `node` and assert its factory export. Today the idiom is proven for `plugin-apollo` only, and it breaks per-package (#611). |
| 14 | [Correct the Fake against real AWS](prds/14-fake-vs-aws-corrections.md) | `[ ]` | 11 | The first live run found 10 places where 1473 green tests assert something SES does not do. Move the Fake to match AWS. Settle the BYODKIM `Tokens` question from AWS's docs first — it decides whether the one-DNS-record claim survives. |
| 13 | [Declare `consumesIdempotencyKey`](prds/13-consumes-idempotency-key-capability.md) | `[x]` | 10 | Retire the `meta.id === "hogsend"` hardcode behind a declared `EmailProviderCapabilities` flag, so a third-party provider can opt into key threading by writing correct code rather than by being named right. |

Order is by time-value, not dependency: 11 first because the AWS account is being created now and the
script should be waiting when it lands.

## Build order rationale

01 runs in parallel with everything because it is calendar time, not engineering time.

02 is the spine: it is the only PRD that talks to AWS, so getting its contract and Fake right makes
every downstream PRD testable. 03 and 06 fan out from it and are independent of each other. 04 needs
03's wire contract. 05, 07, 08, 09 each need one or both of 03/06. 10 is last because it is the
integration that only makes sense once the pieces underneath are real.

The stack is deliberately smaller than the brief implied: `DomainsCapability`, CLI `dns-apply`,
`usage_counters.emailsCount`, `provider_keys` encryption, and the billing contract all already
exist. We are implementing into seams, not building them.

## Plan-review findings (applied 2026-08-10)

Recorded so a reader knows these were caught in review rather than designed in.

1. **04 ↔ 05 dependency cycle.** PRD 04's webhook parser needed a payload shape PRD 05 was to define,
   while 05 depended on 04. Resolved by giving 04 ownership of `HogsendRelayEmailEvent`; 05 imports
   and produces it.
2. **PRD 02's verb list could not support PRD 06's teardown.** No delete verbs, and no
   `putEventDestination` for PRD 05. Contract expanded and declared up front in one table.

   That expansion was still wrong, and BUILD caught three further defects by checking the table
   against AWS's own API reference rather than against itself: `putSuppressionScope` was specified as
   a configuration-set operation when it is a tenant one (the config-set call **cannot** set tenant
   scope, so the bug would have been a silent cross-tenant suppression leak); `getTenant` was
   missing, making the PRD's own idempotency criterion unimplementable; and `getReputationEntity` was
   missing, leaving the relay's paused check fail-OPEN. **The final contract is nineteen verbs.** See
   PRD 02's Implementation Notes.
3. **PRD 07 described identity verbs as new** when PRD 02 already declared them. Reworded to
   "implement", so the seam stays the single point of declaration.
4. **PRD 07 tasks 6 and 7 spanned two package boundaries.** Split into control-plane and plugin
   tasks so each is independently TDD-able.
5. **Batch idempotency and rate limiting were unspecified.** A per-request batch key makes a
   partially failed batch un-retryable, so keys are per item. And the monthly allowance does nothing
   against a leaked token emptying it in ninety seconds, so PRD 03 gains a per-environment burst
   limit.

## Seam register

Populated during BUILD as each `[~]` lands. See DECISIONS §7 for the known ones up front.

| PRD | External ask | Status |
| --- | --- | --- |
| 01 | ~~Create the AWS account and the `hogsend-cloud-relay` IAM user.~~ **DONE 2026-08-11.** Used the existing `dougwithseismic` account (929600381829) rather than a dedicated one: it sends no other email, startup credits land on it, and BYODKIM means a later migration needs no customer DNS change. Policy `HogsendEmailRelay` (20 actions incl. `ses:ListTenants`), user `hogsend-cloud-relay`, creds in `apps/cloud/.env.local`. | done |
| 01 | Submit the production-access request for BOTH `us-east-1` and `eu-west-1`. Text is written and ready to send. **STILL THE ONLY ITEM ON SOMEONE ELSE'S CLOCK.** | open |
| 11 | Delete `~/Downloads/hogsend-cloud-relay_accessKeys.csv` from the local machine. | open |
| 14 | Do NOT promote `CLOUD_AWS_ACCESS_KEY_ID`/`CLOUD_AWS_SECRET_ACCESS_KEY` to Railway until (a) PRD 14 closes the Fake divergences and (b) production access is granted. Those two vars are the switch that makes the control plane create REAL SES resources per customer; `getSesClient` falls back to the Fake without them. | open |
| 14 | A real SNS topic in the SES account + `sns:` actions on the relay policy, so `putEventDestination` can be proven. Untested today. | open |
| 14 | A verified recipient address for a real sandbox send (`sendEmail`/`sendBatch` are the only wires never exercised against AWS). Needs a human to click AWS's verification link. | open |
| 01 | Approve the AUP and ToS copy. Each carries inline `Needs Doug` blocks at the specific open questions. | open |
| 01 | ~~Create `abuse@hogsend.com` as a real monitored mailbox.~~ **RESOLVED 2026-08-11.** It was never actually blocked: hogsend.com already had a Cloudflare Email Routing catch-all forwarding every address to `doug@withseismic.com`, so `abuse@` has been reachable the whole time. An explicit named rule (`abuse`, literal matcher, priority 10) was added so the address survives the catch-all ever being disabled or narrowed. | done |
| 12 | INVESTIGATE the scaffold-smoke divergence: `pnpm --filter create-hogsend verify` fails locally at step 5 with 33 zod `.refine` inference errors, at the branch base as well as on the branch, with and without a prior `pnpm build` — while CI ran the same step on the same commit and passed. Until this is understood, a green CI is not evidence that a published scaffold type-checks. PRD 12's own assertion has never executed. | open |
| 11 | RUN the walkthrough once the AWS account exists: `pnpm --filter @hogsend/cloud ses:walkthrough --i-know-this-hits-aws`. Sandbox is enough. Until it runs, the Fake-vs-AWS divergence count is UNKNOWN, not zero. | open |
| 01 | Confirm the trust-tier and suspension constants proposed in PRD 08. They are already published to customers in the AUP §5, so the two move together. | open |
</content>
