# Hogsend Email: terms clause and suspension notice copy

Draft for approval. Not published. Dated 10 August 2026.

Two things live here. Part A is the clause that goes into the Hogsend Cloud terms. Part B is the
copy for the emails a customer receives when their sending is suspended and when it comes back.

The existing public terms at `hogsend.com/terms` cover the source-available (ELv2) software that
customers run themselves. They say nothing about a service we operate on a customer's behalf, so
Part A is an addition to the Cloud terms, not an edit to that page.

> **Needs Doug:** the Cloud terms need a named contracting entity. The current public terms name
> none, which is survivable for software provided as is and is not survivable for a paid service
> that suspends accounts. Every `Hogsend` below becomes the entity name once you have one.

---

## Part A: terms clause

Numbered for insertion. Renumber to fit the surrounding document, but keep the internal
cross-references consistent if you do.

### N. Hogsend Email

**N.1 What it is.** Hogsend Email is a sending service included with your Hogsend Cloud
subscription. We operate the sending infrastructure, hold the provider relationship, and send your
mail on your behalf from a domain you verify.

**N.2 It is not a standalone email service.** Hogsend Email is available only as part of an active
Hogsend Cloud subscription, is not sold separately, and has no separate service level commitment.
You may not resell it, relay third-party mail through it, or use it as a sending backend for anyone
other than yourself. If your subscription ends, sending ends with it.

**N.3 You do not get credentials to the underlying infrastructure.** Your Cloud environment holds a
token that authorises it to send through us, and nothing else.

**N.4 Alternatives.** You are not required to use Hogsend Email. Hogsend supports customer-supplied
email providers, and you may configure your own provider account at any time. Mail sent that way is
governed by that provider's terms, not by this clause or the Acceptable Use Policy.

**N.5 Allowance.** Your plan includes a monthly email allowance. Sending above it is billed as
overage at the published rate, or refused where your plan or trust tier sets a hard cap. Allowances
and caps are stated on the pricing page and in your Cloud dashboard.

**N.6 Your warranty on consent.** You warrant that every recipient you send to has given you
permission to email them, that you can evidence that permission, and that your sending complies with
the law that applies to you and to your recipients, including the UK GDPR, the EU GDPR, PECR,
CAN-SPAM and CASL where applicable. You are the data controller for your recipients. We are your
processor for the sending.

**N.7 Acceptable use.** The Hogsend Email Acceptable Use Policy applies to all sending through the
service and forms part of these terms. Breaching it is a breach of these terms.

**N.8 We may suspend sending.** We may suspend sending for one of your environments immediately and
without prior notice where its bounce or complaint rate crosses the thresholds in the Acceptable Use
Policy, where the sending infrastructure pauses it automatically, or where we reasonably believe the
Acceptable Use Policy has been breached. Because every customer sends through infrastructure we
operate, one sender's reputation problem degrades delivery for everyone else, and protecting
aggregate deliverability is a condition of offering the service at all.

**N.9 What a suspension affects.** A suspension stops sending for the affected environment only.
Your data, your journeys, your ingestion and the rest of your Cloud subscription continue to run.
Send attempts fail with the recorded cause rather than queueing. We will tell you which clause was
breached and what the measured numbers were, and there is an appeals route in the Acceptable Use
Policy.

**N.10 No deliverability warranty.** We do not warrant that any message will be delivered, will
reach an inbox rather than a spam folder, or will be accepted by any mailbox provider. Inbox
placement is decided by mailbox providers on signals that include your content, your list and your
recipients' behaviour, none of which we control.

**N.11 Suspension is not a refund event.** A suspension under N.8 does not entitle you to a refund
or a credit for the affected period. The rest of your subscription is unaffected and continues.

**N.12 On termination.** When your subscription ends, sending stops, your sending identity is
removed from our infrastructure, and your suppression list is retained for the period stated in the
Acceptable Use Policy. You can export your suppression list before you leave, and during that
period afterwards. Your domain remains yours; removing the DNS records you added is your step to
take.

**N.13 Liability.** Our total liability arising from Hogsend Email is capped at the fees you paid
for the Hogsend Cloud subscription in the twelve months before the claim. We are not liable for lost
revenue, lost deliverability, or the consequences of a suspension applied in accordance with N.8.

> **Needs Doug:** N.6 states we are the processor and you are the controller for recipient data.
> That is the standard and correct position, and it implies a data processing agreement exists for
> Cloud. Confirm one does, or that writing it is on the list, because N.6 asserts it.

> **Needs Doug:** N.11. Refusing a refund on a suspension is the defensible position and it is also
> the one a customer argues with. The alternative is silence, which means arguing it case by case.

---

## Part B: suspension notice

One notice per suspension event, to the environment owner. PRD 08 sends it, keyed on the pause event
id so a redelivered infrastructure event does not send it twice.

This email arrives at a bad moment, usually mid-campaign, usually as a surprise. It has four jobs:
say what happened, say which clause, show the numbers, and give one clear next action. It does not
apologise, does not soften, and does not bury the appeal route at the bottom.

### Tokens

| Token | Example | Source |
| --- | --- | --- |
| `{{environment}}` | `production` | environment name |
| `{{organization}}` | `Acme` | organization name |
| `{{suspendedAt}}` | `10 August 2026 at 14:32 UTC` | pause event timestamp |
| `{{clause}}` | `5.1` | the AUP clause cited |
| `{{clauseTitle}}` | `Reputation thresholds` | heading of that clause |
| `{{metric}}` | `complaint rate` | from the finding |
| `{{measured}}` | `0.31%` | from the finding |
| `{{threshold}}` | `0.1%` | from the AUP clause |
| `{{volume}}` | `4,180` | messages the rate was measured over |
| `{{window}}` | `8 August to 10 August` | measurement window |
| `{{cause}}` | verbatim cause string | recorded pause cause |
| `{{appealEmail}}` | `abuse@hogsend.com` | constant |

### Variant 1: automatic suspension on a reputation threshold

Cites AUP §5.1 and §6.1. This is the common case.

**Subject:** `Sending suspended for {{environment}}`

**Preheader:** `{{metric}} reached {{measured}}. Here is what happened and how to get sending back.`

**Body:**

```
Sending is suspended for your {{environment}} environment as of {{suspendedAt}}.

WHAT HAPPENED

Your {{metric}} reached {{measured}} across {{volume}} messages sent between {{window}}. The limit
is {{threshold}}.

This breaches clause {{clause}} of the Hogsend Email Acceptable Use Policy, {{clauseTitle}}. The
suspension was automatic, which clause 6.1 allows, because at that rate every additional send makes
the problem harder to recover from.

Recorded cause: {{cause}}

WHAT THIS AFFECTS

Sending from {{environment}} only. Every send attempt now fails with this reason instead of
queueing, so nothing is sitting in a backlog waiting to go out when this resolves. Your other
environments are unaffected.

Everything else keeps running: event ingestion, journeys, contacts, the API, and Studio. Your data
is untouched.

WHAT TO DO

Reply to this email and tell us three things:

1. What caused the {{metric}}. The usual answers are a list that was imported rather than collected,
   a segment that had not been mailed in a long time, or a send that went to addresses gathered for
   a different purpose.
2. What you have changed.
3. What list you will send to when sending resumes, and where those addresses came from.

A person reads every reply. We aim to respond within one working day.

Reinstatement is not automatic and we cannot grant it on request alone. Sending resumed over an
unresolved cause suspends again within days, and the second suspension is harder to recover from
than the first. That is why the questions above are the whole process.

Full policy: https://hogsend.com/acceptable-use
Your sending status: https://cloud.hogsend.com/environments/{{environment}}
```

### Variant 2: manual suspension on a policy breach

Cites the specific §2 or §3 clause and §6.2. Same structure, no rate numbers, because there are
none.

**Subject:** `Sending suspended for {{environment}}`

**Body:** replace the `WHAT HAPPENED` section with:

```
WHAT HAPPENED

We suspended sending after reviewing activity on this environment. It breaches clause {{clause}} of
the Hogsend Email Acceptable Use Policy, {{clauseTitle}}.

{{cause}}

Clause 6.2 allows us to suspend immediately where continued sending would put other customers'
delivery at risk.
```

The rest of the email is unchanged, except that where the cited clause is 3.2 (phishing and
impersonation) or 3.3 (malware), the `WHAT TO DO` section is replaced entirely with:

```
WHAT TO DO

Nothing. Clause 6.7 of the Acceptable Use Policy provides no appeal for this clause. Sending from
this environment has ended permanently.
```

> **Needs Doug:** whether a §3.2 or §3.3 suspension also ends the whole Cloud subscription, or only
> sending. The AUP §6.4 says a repeat breach "may end the Hogsend Cloud subscription", which leaves
> the first phishing incident ambiguous. Recommendation: end the subscription too, and say so here.

### Variant 3: reinstatement

Not required by PRD 08 task 7. Included because a suspension notice that promises a way back needs
its other half, and a customer who fixes the problem and hears nothing assumes we forgot.

**Subject:** `Sending restored for {{environment}}`

**Body:**

```
Sending is available again for your {{environment}} environment.

Your account is on the watched tier. Automated enforcement is set to pause on any reputation
finding, including a low severity one, and your sending cap is reduced until the record is clean
again. Bulk list import stays unavailable at this tier.

Start smaller than you finished. Your most recently engaged recipients first, then widen once the
rates hold. Your bounce and complaint rates are on your dashboard and are what decides how quickly
the cap comes back.

Your sending status: https://cloud.hogsend.com/environments/{{environment}}
```

> **Needs Doug:** the reinstatement email names the watched-tier consequences, which is honest and
> is also the moment a customer decides whether to stay. Confirm the reduced cap number when PRD
> 08's tier numbers are settled, and confirm the two links used across all three variants
> (`hogsend.com/acceptable-use` and `cloud.hogsend.com/environments/...`) are the addresses these
> will actually live at.
