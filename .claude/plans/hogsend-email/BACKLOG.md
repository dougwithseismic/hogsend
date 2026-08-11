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
| 01 | Create the `hogsend-email-prod` AWS account and the `hogsend-cloud-relay` IAM user. Policy JSON is written and every action name verified: `docs/ses-production-access-request.md` Appendix A. | open |
| 01 | Submit the production-access request for BOTH `us-east-1` and `eu-west-1`. Text is written and ready to send. | open |
| 01 | Approve the AUP and ToS copy. Each carries inline `Needs Doug` blocks at the specific open questions. | open |
| 01 | Create `abuse@hogsend.com` as a real monitored mailbox, or decide it becomes `hello@hogsend.com`. It is cited in the AUP §6.6/§8.1 and in the AWS request. | open |
| 01 | Confirm the trust-tier and suspension constants proposed in PRD 08. They are already published to customers in the AUP §5, so the two move together. | open |
</content>
