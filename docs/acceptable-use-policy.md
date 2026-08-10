# Hogsend Email Acceptable Use Policy

Draft for approval. Not published. Dated 10 August 2026.

> **Maintenance note, not part of the published policy.** Every threshold and tier in §5 and §6
> mirrors PRD 08 of the Hogsend Email plan stack, `08-abuse-enforcement.md`. The two must never
> disagree. If a number changes, change it in PRD 08 first and copy it here in the same commit.
> Clause numbers are load-bearing: the suspension notice in `docs/hogsend-email-terms.md` cites
> them verbatim, so renumber a clause and you break a customer email.

Every clause below maps to a signal we can observe or to a named enforcement action. A rule we
cannot detect is noise that weakens the ones we can, so there are no aspirational clauses here.

---

## 1. Scope

**1.1** This policy governs all email sent through Hogsend Email, the sending service bundled with
Hogsend Cloud. It applies to you, to anyone you give access to your Hogsend Cloud organization, and
to any system you connect to it.

**1.2** Enforcement is per environment. One Hogsend Cloud environment is one isolated sending
tenant with its own reputation, its own suppression list and its own sending status. Suspending one
environment does not affect any other environment, including your own.

**1.3** This policy is incorporated into the Hogsend Cloud terms. Breaching it is a breach of those
terms.

**1.4** This policy does not apply to email you send through your own provider account. If you
supply your own Resend or Postmark credentials, your relationship is with that provider and their
policy governs it.

---

## 2. Consent

**2.1** You may only send to recipients who gave you their email address directly and who would
recognise you as the sender.

*Signal:* complaint rate, spamtrap reports relayed to us by AWS Trust and Safety, direct recipient
reports to `abuse@hogsend.com`.
*Enforcement:* §6.

**2.2** You may not send to purchased, rented, scraped, appended, or otherwise third-party-sourced
lists. Buying a list is a breach whether or not the sending that follows performs well.

*Signal:* bounce rate on a newly imported list against a tenant with no prior sending history;
sudden volume with no matching contact-creation history; spamtrap hits.
*Enforcement:* bulk list import is blocked below the `established` tier under §5.3, which is a
structural block rather than a detection. A finding after import triggers §6.1.

**2.3** Bulk imports must record where the addresses came from and when consent was given. Imports
without that record may be refused.

*Signal:* the import declaration, captured at import time.
*Enforcement:* the import is refused. Repeated refusal attempts are reviewed under §6.4.

**2.4** You may not send to an address after that recipient has unsubscribed, however they did it.

*Signal:* enforced in software. Every send passes one preference and suppression check before
dispatch; an unsubscribed recipient produces a recorded skip, not a delivery. Attempting to send to
an unsubscribed recipient is visible in your own send log.
*Enforcement:* automatic and permanent at the send path. Deliberately circumventing it, for example
by re-importing suppressed addresses under a new identifier, is a breach under §3.7.

**2.5** Every marketing message must carry a working unsubscribe link and a working
`List-Unsubscribe` header. Both are added automatically. You may not remove, obscure, or redirect
them to a page that does not unsubscribe.

*Signal:* templates are rendered through our pipeline, so a missing or altered unsubscribe target is
observable at send time.
*Enforcement:* §6.

---

## 3. Prohibited use

**3.1** Unsolicited bulk email, in any volume.

*Signal:* complaint rate under §5.1, AWS reputation findings, direct reports.
*Enforcement:* §6.1 or §6.2.

**3.2** Phishing, credential harvesting, or impersonating another person, brand, or organisation.
This includes impersonating Hogsend, Amazon, or any payment provider.

*Signal:* recipient reports, mailbox provider feedback relayed by AWS, blocklist notifications
naming a domain in your message content.
*Enforcement:* §6.2, immediate and permanent. There is no appeal for this clause.

**3.3** Distributing malware, exploit payloads, or links to either.

*Signal:* domain blocklist notifications from AWS, recipient reports.
*Enforcement:* §6.2, immediate and permanent. There is no appeal for this clause.

**3.4** Content that is unlawful where the recipient is, or that promotes unlawful goods or
services.

*Signal:* recipient reports, regulator or mailbox provider contact, AWS Trust and Safety case.
*Enforcement:* §6.2.

**3.5** These categories require written approval before you send them, because they carry
structurally high complaint rates regardless of how the list was built: adult content, gambling,
short-term and payday lending, debt relief, cryptocurrency and token promotion, multi-level
marketing and business-opportunity offers, and pharmaceuticals.

*Signal:* the category is declared at signup or observed in message content following a report.
Complaint rate is the leading indicator either way.
*Enforcement:* sending in an unapproved category is §6.2. Approved senders in these categories are
held on the `watched` tier under §5.2.

**3.6** You may only send from a domain you control and have verified. Verification is a DNS record
you place yourself.

*Signal:* enforced in software. An unverified identity cannot send.
*Enforcement:* structural. There is nothing to detect.

**3.7** You may not forge headers, misrepresent the sender, use a misleading subject line, or use
technical means to evade suppression, unsubscribe handling, rate limits, or sending caps.

*Signal:* the `From` address is constrained to a verified identity, so forgery attempts fail at the
send path and are logged. Suppression evasion shows as a re-import of addresses already suppressed
for this environment.
*Enforcement:* §6.2.

**3.8** You may not resell Hogsend Email as a standalone sending service, relay mail on behalf of a
third party, or use your environment as a shared sending account for senders who are not you.
Hogsend Email is a feature of your Cloud subscription, not an email API you can put a wrapper
around.

*Signal:* sends whose `From` domain is not an identity verified to your environment are impossible.
The observable pattern is many unrelated sending domains verified against one environment, or
recipient reports naming a brand that is not yours.
*Enforcement:* §6.2.

---

## 4. Volume and rate

**4.1** Each environment has a sending cap set by its plan and its trust tier under §5. Sends above
the cap are refused, not queued.

*Signal:* metered per environment, per billing period.
*Enforcement:* automatic refusal at the send path, with the reason stated.

**4.2** You may not split sending across multiple environments or organizations to defeat a cap or a
suspension.

*Signal:* a new environment or organization created with the same billing identity, domain, or
recipient list shortly after a suspension.
*Enforcement:* §6.4, applied to every linked environment.

---

## 5. Reputation thresholds and trust tiers

**5.1 Rates you must stay inside.** Measured over a representative volume of your recent sending:

| Metric | Required | Sending is suspended at |
| --- | --- | --- |
| Hard bounce rate | below 5% | 5% or greater |
| Complaint rate | below 0.1% | 0.1% or greater |

These are the levels at which Amazon Web Services places an entire sending account under review, and
at 10% bounce or 0.5% complaint it may pause the account outright. Because every Hogsend Email
tenant sends through infrastructure we own, one tenant reaching those levels puts every other
customer's mail at risk. We therefore suspend at the review threshold rather than the pause
threshold.

*Signal:* bounce and complaint rates reported per tenant by the sending infrastructure, plus
reputation findings raised against the tenant.
*Enforcement:* §6.1.

> **Needs Doug:** these two numbers are the AWS account-review thresholds, quoted from the Amazon
> SES documentation, and PRD 08 does not currently name a Hogsend-side number at all. Suspending at
> 5% and 0.1% is the recommendation, because it is the last point at which a single tenant is still
> our problem rather than AWS's. If you want a softer number, it has to go into PRD 08 first, and it
> has to be above the rate at which AWS opens a review on us.

**5.2 Trust tiers.** Every environment sits in one tier. The tier sets the automated enforcement
level applied by the sending infrastructure, the sending cap, and whether bulk import is available.

| Tier | Entered by | Automated enforcement | Send cap | Bulk import |
| --- | --- | --- | --- | --- |
| `new` | at provisioning | observed, no automatic pause | low daily cap | blocked |
| `established` | clean sending over a defined volume and window | pause on high-severity findings | plan allowance | allowed |
| `watched` | automatically, on any reputation finding | pause on any finding, including low severity | reduced | blocked |

Promotion to `established` is automatic once the criteria are met. Demotion to `watched` is
automatic and immediate. Promotion out of `watched` is a human review, never automatic.

*Signal:* sending volume, window, bounce rate and complaint rate per tenant; reputation findings.
*Enforcement:* the tier change applies the corresponding enforcement level and cap without further
notice.

> **Needs Doug:** the concrete numbers behind this table are still open in PRD 08 and are needed
> before this policy is published, because "a defined volume and window" is not something a customer
> can plan against. Proposed, for your approval: `new` cap of 500 emails per day; promotion to
> `established` after 14 consecutive days of sending with at least 1,000 messages delivered, bounce
> rate below 2% and complaint rate below 0.05%; `watched` cap of 25% of the plan allowance. Whatever
> you settle on has to land in PRD 08 as named constants in one place and be restated here.

**5.3 New and watched environments cannot bulk import a list.** This is not a rate limit, it is a
block. An environment with no established sending record cannot perform a large first send to a list
we have never seen.

*Signal:* structural. The import is refused with the tier requirement named.
*Enforcement:* the refusal is the enforcement.

---

## 6. Suspension and appeals

**6.1 Suspension may be automatic and immediate.** When the sending infrastructure detects a
reputation problem at the level your tier enforces, or when a rate in §5.1 is crossed, sending for
that environment stops without prior notice and without human involvement. We do not warn first. A
warning period at those rates is measured in tens of thousands of messages already delivered.

**6.2 We may also suspend an environment manually**, immediately and without notice, on evidence of
a breach of §2 or §3, or where continued sending would put the deliverability of other customers at
risk.

**6.3 What a suspension does.** Sending for the environment fails closed. Every send attempt returns
an explicit paused status naming the recorded cause; nothing is silently queued, retried, or
rerouted. Your journeys record the reason. A suspended environment cannot switch to its own provider
credentials to keep sending. Everything else in the environment keeps running: ingestion, journeys,
data, and the API.

**6.4 Repeat breaches.** A second suspension for the same clause, or evidence of deliberate evasion
under §3.7 or §4.2, ends sending on that environment permanently and may end the Hogsend Cloud
subscription.

**6.5 Notice.** We send a notice to the environment's owner once per suspension. It states the
clause breached, the measured numbers behind the decision, and what to do next.

**6.6 Appeals.** Reply to the suspension notice, or write to `abuse@hogsend.com` from the
environment owner's address. An appeal is reviewed by a person. Reinstatement is never automatic and
is never granted on request alone: it requires the cause to be resolved, because sending resumed
over an unresolved cause pauses again within days and the second pause is worse than the first.

Tell us, in the reply:

1. What caused the bounces or complaints.
2. What you changed.
3. What list you will send to when sending resumes, and where those addresses came from.

**6.7 No appeal is available under §3.2 or §3.3.** Phishing and malware end sending permanently.

**6.8 Response time.** We aim to give an initial response to an appeal within one working day.

> **Needs Doug:** whether to commit to one working day in writing. It is a promise a solo team has
> to keep on the day a customer is furious. The alternative is to state no target and answer fast
> anyway.

---

## 7. Suppression lists and data retention

**7.1** Each environment has its own suppression list. Bounces and complaints from your sending
suppress the address for your environment only, and never for another customer.

**7.2** Addresses that hard bounce or file a complaint are added to your suppression list
automatically and are excluded from all future sends from your environment.

**7.3** You cannot remove an address that was suppressed for a complaint. A recipient who reports
your mail as spam has made a decision, and re-sending to them is the fastest route to §5.1.

**7.4** You may remove an address suppressed for a hard bounce, on the understanding that the bounce
counts against §5.1 again if it recurs. Repeatedly clearing and re-sending to the same bouncing
address is evasion under §3.7.

**7.5** Unsubscribe and suppression records are retained for the life of the environment, and for 12
months after the environment is deleted. They are retained even where you delete the underlying
contact, because the record of a withdrawn consent is what proves the withdrawal was honored, and
deleting it would let the same address be re-imported and mailed again.

**7.6** You can export your suppression list at any time while the environment exists. Ask, and we
will export it after deletion within the 12-month window in §7.5.

> **Needs Doug:** the 12-month post-deletion retention in §7.5 is a proposal. It is a genuine legal
> position under GDPR, retaining a minimal record on legitimate-interest grounds specifically to
> keep honoring an opt-out, and it needs to match whatever the Hogsend Cloud privacy policy says.
> Confirm the period, or align it to the privacy policy's existing retention language.

---

## 8. Reports and changes

**8.1** Report abuse of Hogsend Email, including mail you received from a Hogsend customer, to
`abuse@hogsend.com`. Include full message headers.

**8.2** We may change this policy. Material changes are notified to Cloud account owners before they
take effect. The current version is always the one at this address, and it is dated.

> **Needs Doug:** `abuse@hogsend.com` needs to be a real, monitored mailbox before this is
> published. It appears in §6.6, §8.1, and in the AWS production-access request. If it will not
> exist, every reference becomes `hello@hogsend.com`.
