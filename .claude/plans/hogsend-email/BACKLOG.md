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
| 14 | [Correct the Fake against real AWS](prds/14-fake-vs-aws-corrections.md) | `[x]` | 11 | The first live run found 10 places where 1473 green tests assert something SES does not do. Move the Fake to match AWS. Settle the BYODKIM `Tokens` question from AWS's docs first — it decides whether the one-DNS-record claim survives. |
| 15 | [Configurable subdomains + setup guidance](prds/15-sending-subdomain-and-guidance.md) | `[~]` | 07, 14 | The return-path subdomain is hardcoded `send.`; make it choosable (`notifications.`). And TELL customers to send from a subdomain, because verifying the root domain is the obvious move and the wrong one. **Seam:** task 1 (confirm subdomain sending live) needs real AWS, suspended while the account-review case is open. |
| 19 | [Prove the delivery path against real AWS](prds/19-live-event-pipeline-proof.md) | `[~]` | 11, 14, 18 | **SEND PROVEN LIVE 2026-08-11** — `sendEmail`, `sendBatch`, tenant-scoped sending and attachments all accepted by real SES through our own client, 11/11, zero Fake divergences. The script that proves the whole chain (provision → event destination → SNS subscribe → simulator sends → events back → signed instance hop → teardown) is built, reviewed and green: 14 named links, exit-code mapping mutation-proven. **Remaining: one admin run of `aws-bootstrap-events.sh`, then the live run itself.** The public-endpoint blocker is gone (cloudflared is broken; localhost.run works). |
| 18 | [Consume SES `Reject`](prds/18-reject-events.md) | `[x]` | 05, 14 | SES accepts a message, detects a virus, and drops it — no bounce, no delivery, no event. That send never reaches a terminal state today. Must NOT suppress the recipient: the address is fine, our content was not. |
| 17 | [Attachments](prds/17-attachments.md) | `[x]` | 03, 14 | Send a file with an email. THE real capability gap vs Resend and a hard blocker — a customer who must attach an invoice cannot use Hogsend at all. **SHIPPED.** Task 1 refuted this PRD's own premise (SES v2 `Simple` content takes a first-class `Attachments` array, so no MIME assembly and no `sendRawEmail`), which deleted the two hardest tasks. Carried end to end: core contract, SES seam, relay size gate, plugin-hogsend, engine mailer, Resend + Postmark. |
| 16 | [Inbound replies](prds/16-inbound-replies.md) | `[ ]` | 06, 15 | Replies to journey mail become `email.replied` events a journey can wait on. No inbound receiving exists today. Hard safety rule: never touch the customer's apex MX — that is their real company mailbox. |
| 20 | [Branded return path as a one-click upgrade](prds/20-return-path-upgrade.md) | `[x]` | 07, 15 | Doug's answer on the PRD 15 seam: keep it OFF by default, surface it in Setup. `apps/cloud` implements it and `plugin-hogsend` exposes it, but core's `DomainsCapability` has no `setReturnPath`, the engine has no route and Studio has no UI — the capability is unreachable from the product. Copy must never claim it enables replies. |
| 21 | [Fake association gaps](prds/21-fake-association-gaps.md) | `[ ]` | 11, 14 | The SECOND live walkthrough (2026-08-11) found 20/22 verbs clean — PRD 14's corrections HOLD. The three that disagreed share ONE root: the Fake's `associateResource` accepted a resource that does not exist, so a walkthrough bug (deriving an email-address sender's ARN from its parent domain) produced an association AWS 404s and a send it 403s. **Correction:** an earlier version of this row claimed the Fake sends without association — it does not, PRD 14 added that rule in `7b01b124`; it was satisfied by a seeded fiction. |
| 13 | [Declare `consumesIdempotencyKey`](prds/13-consumes-idempotency-key-capability.md) | `[x]` | 10 | Retire the `meta.id === "hogsend"` hardcode behind a declared `EmailProviderCapabilities` flag, so a third-party provider can opt into key threading by writing correct code rather than by being named right. |

Order is by time-value, not dependency: 11 first because the AWS account is being created now and the
script should be waiting when it lands.

### Reprioritised 2026-08-11 — launch-critical first

Doug's call: push to a real cloud-customer test rather than continue feature work, and live AWS runs
are authorized again (his judgement on the open account-review case, stated explicitly). He was also
right on the technical point that reordered this list: **the sandbox can send**, via the mailbox
simulator, so the delivery proof was never gated on production access.

A probe of the real account then removed two more assumed blockers — `ses:SendEmail` is already
granted, and `cloudflared` is installed so the public HTTPS endpoint needs no account. See PRD 19's
notes. The remaining blockers are three small, precise, human steps rather than engineering.

New order: **19** (prove delivery) → **20** (return-path upgrade, fully unblocked code) → **16**
(inbound replies) → **12**. PRDs 16 and 20 are feature work and do not block launch; 19 does.

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
| 19 | ~~A verified recipient for a real sandbox send.~~ **NOT NEEDED — corrected 2026-08-11.** SES's mailbox simulator (`success@`/`bounce@`/`complaint@simulator.amazonses.com`) works in sandbox with no recipient verification, does not affect reputation or quota, and emits real events. | done |
| 19 | ~~A public HTTPS endpoint for SNS.~~ **SELF-SERVED 2026-08-11.** `cloudflared` is installed and `scripts/discord-tunnel.sh` is in-repo precedent; a quick tunnel gives a public `*.trycloudflare.com` URL with no account, no token and no DNS. Rejected the Railway alternative because it reopens the deliberately-closed credential gate. | done |
| 19 | **RUN `apps/cloud/scripts/aws-bootstrap-events.sh` with ADMIN credentials** (`aws configure`, then the script; `DRY_RUN=1` to preview). Idempotent. Creates the two SNS topics + `SourceAccount`-scoped publish policies, and adds an additive inline grant to the relay user (`sns:Subscribe`/`Unsubscribe`, plus the read-only `ses:GetAccount`/`ses:ListEmailIdentities` that were missing from the original 20). Prints the two `CLOUD_SES_SNS_TOPIC_ARN_*` lines to paste into `apps/cloud/.env.local`. The relay key cannot do any of this by design, and the script refuses if run with it. | open |
| 19 | ~~**CLICK the SES verification link** for `ses-proof@hogsend.com`.~~ **DONE 2026-08-11**, and the send verbs ran the same hour: `sendEmail`, `sendBatch` and an attachment all accepted by real SES through our own `AwsSesClient`, 11/11 steps, zero Fake divergences, tenant torn down. See PRD 19's notes for the message ids. **Still owed:** a real inbox to confirm attachment BYTES (acceptance is not integrity — double-base64 delivers a corrupt file and still returns a message id). | done |
| 17 | CONFIRM ATTACHMENT INTEGRITY against a real inbox. SES accepted an attached file on 2026-08-11 and returned a message id, but acceptance is not integrity: the failure `ses/types.ts` warns about (already-base64 content encoded a SECOND time by the SDK) delivers a corrupt file and still succeeds at every layer. A simulator address cannot answer it. Needs one send to a human-readable inbox and a human opening the file. Doug's explicit go-ahead required — a real inbox is never a default test target. | open |
| 01 | Approve the AUP and ToS copy. Each carries inline `Needs Doug` blocks at the specific open questions. | open |
| 01 | ~~Create `abuse@hogsend.com` as a real monitored mailbox.~~ **RESOLVED 2026-08-11.** It was never actually blocked: hogsend.com already had a Cloudflare Email Routing catch-all forwarding every address to `doug@withseismic.com`, so `abuse@` has been reachable the whole time. An explicit named rule (`abuse`, literal matcher, priority 10) was added so the address survives the catch-all ever being disabled or narrowed. | done |
| 12 | INVESTIGATE the scaffold-smoke divergence: `pnpm --filter create-hogsend verify` fails locally at step 5 with 33 zod `.refine` inference errors, at the branch base as well as on the branch, with and without a prior `pnpm build` — while CI ran the same step on the same commit and passed. Until this is understood, a green CI is not evidence that a published scaffold type-checks. PRD 12's own assertion has never executed. | open |
| 11 | RUN the walkthrough once the AWS account exists: `pnpm --filter @hogsend/cloud ses:walkthrough --i-know-this-hits-aws`. Sandbox is enough. Until it runs, the Fake-vs-AWS divergence count is UNKNOWN, not zero. | open |
| 01 | Confirm the trust-tier and suspension constants proposed in PRD 08. They are already published to customers in the AUP §5, so the two move together. | open |
| — | FLAKY TEST: `apps/cloud/src/__tests__/publish-cli-auth.test.ts > refuses a REVOKED session, storing nothing` failed **twice in five** full-suite runs on 2026-08-11, on diffs touching only the SES seam and the relay. **The security reading is RULED OUT** — `CliSessionService` line 208 refuses on `if (row.revokedAt)`, a null check rather than a timestamp comparison, so there is no window in which a revoked session is accepted. That was the only hypothesis worth the time. What remains is test-infrastructure contention (the test asserts `buildRows(envA)` is empty and shares one Postgres with parallel vitest files; a leaked row or a burst-limit 429 in place of the expected 401 both fit). Capture the actual assertion diff next time it fires rather than guessing again. Recorded because an unnamed flake gets misattributed to whatever change is in flight when it next fails. | open |
| 15 | RUN the walkthrough with `--identity-domain notifications.<domain>` to confirm subdomain sending against real SES. Blocked by the same live-AWS suspension as PRD 11. Everything else in PRD 15 shipped. | open |
| 15 | ~~Decide whether the branded return path should be ON by default.~~ **ANSWERED 2026-08-11: no.** Keep it off (one record stays the wedge, it is reversible with no downtime, every extra DNS record loses people in setup) and surface it in Setup as a labelled one-click upgrade. The original reason for wanting it on was replies, which it does not deliver. Queued as PRD 20. | done |
</content>
