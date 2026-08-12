# SES production access request

**Ready to submit.** Every open decision below was settled on 2026-08-12:
mail type `MARKETING`, abuse contact `abuse@hogsend.com` (Doug is creating the
mailbox), opening quota 50,000 per 24 hours at 14 per second, and the ramp
triggers as written. Nothing here has been submitted yet.

**One precondition:** `abuse@hogsend.com` has to accept mail BEFORE either
submission goes in. It is named in the AWS case as the operational abuse
contact and in the published Acceptable Use Policy as the appeals route, so
submitting first would put an address in front of AWS that bounces — which is
the specific thing an ISV request cannot afford to get wrong.

Two submissions are needed, one per region: `us-east-1` and `eu-west-1`. Sandbox status is per
region, so a single approval covers one region only. Submit both on the same day; a second wait,
started later, lands at exactly the wrong moment.

Each submission has two parts:

1. The **account details form** in the SES console (Account dashboard, Get set up, Request
   production access), or the equivalent `aws sesv2 put-account-details` call.
2. A **support case** carrying the sending model, the abuse controls, and the quota ask. The form
   alone gives AWS a mail type and a URL. The case is where the multi-tenant model is explained,
   and explaining it up front is what stops the request bouncing back with questions.

---

## Part 1: account details form

| Field | Value |
| --- | --- |
| Mail type | `MARKETING` |
| Website URL | `https://hogsend.com` |
| Additional contacts | `hello@hogsend.com`, `abuse@hogsend.com` |
| Preferred contact language | English |
| Acknowledgement | Checked |

CLI equivalent, run once per region:

```bash
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type MARKETING \
  --website-url https://hogsend.com \
  --additional-contact-email-addresses hello@hogsend.com,abuse@hogsend.com \
  --contact-language EN \
  --region us-east-1

aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type MARKETING \
  --website-url https://hogsend.com \
  --additional-contact-email-addresses hello@hogsend.com,abuse@hogsend.com \
  --contact-language EN \
  --region eu-west-1
```

AWS asks which type describes the majority of mail. Hogsend Email carries lifecycle mail triggered
by a recipient's own actions, which is transactional in shape, and it also carries broadcasts, which
are marketing. `MARKETING` is the honest declaration of the two, and it is the one that does not
have to be corrected later.

> **Settled 2026-08-12:** `MARKETING`. Declaring `TRANSACTIONAL` and then running broadcasts is the
> version of this that ends in a Trust and Safety case.

> **Settled 2026-08-12:** `abuse@hogsend.com` stays, and Doug is creating the mailbox. It must
> accept mail before either submission goes in — see the precondition at the top.

---

## Part 2: support case

Case type: Service limit increase, SES Sending Limits. One case per region.

### Subject

```
SES production access and initial sending quota, multi-tenant ISV using SES Tenants
```

### Body

```
We are requesting production access and an initial sending quota for this account in <REGION>.

WHAT WE SEND

Hogsend is lifecycle email and journey orchestration software. Hogsend Cloud is the hosted version:
a customer signs up, we provision an isolated stack for them, they verify a domain they own, and
their journeys send email from that domain. We are the ISV; the sending is on behalf of our paying
customers, each of which is a distinct SES tenant in this account.

Mail is lifecycle mail: onboarding sequences, activation and re-engagement journeys, product
notifications, and periodic broadcasts. Every message is sent from a domain the customer has
verified with a DNS record they placed themselves, to their own recipients, under their own brand.
We do not send on behalf of anyone who has not verified a domain.

WHO CAN SEND

This is the control we would like weighted most heavily.

There is no public signup for email sending. Hogsend Email is not a standalone email API and is not
sold as one. It is a bundled feature of a paid Hogsend Cloud subscription, and Hogsend Cloud is the
only issuer of a sending credential. To send one message through this account, a person has to
subscribe to a paid plan, provision a stack, and verify a domain they control by placing a DNS
record. There is no free tier that sends, no self-serve email-only product, and no path by which a
credit card alone buys sending capacity.

The consequence is the population. Our senders are teams who bought lifecycle automation software
and deployed it. That population has a near-zero spammer rate. We are choosing it deliberately, and
we have no plan to open a public sending signup.

ISOLATION

We use SES Tenants. One SES tenant per customer environment, named env-<environment-id>, created at
provisioning time. Tenant names contain no customer-controlled string. Each tenant gets:

- Its own configuration set, associated to the tenant.
- Its own verified identity or identities, associated to the tenant.
- Tenant-level suppression (SuppressionScope: TENANT, SuppressedReasons: BOUNCE and COMPLAINT), so
  one customer's bounces and complaints never leak into another customer's sending, and never
  silently disappear into a shared list either.
- Its own reputation entity and reputation policy.

Tenants are region-scoped, so an environment's tenant is created in exactly one region and stays
there. We run both us-east-1 and eu-west-1 because our EU customers require EU data residency.

We understand that tenant isolation bounds a reputation problem, it does not remove it, and that the
combined activity of our tenants is still our account's reputation to protect. Everything below
exists because we treat the aggregate as ours.

REPUTATION POLICY POSTURE

A new tenant is created on reputation policy None and held under a low daily send cap that we
enforce ourselves, before the message reaches SES. None here is observation, not permissiveness:
the cap is what bounds a new tenant's damage, and it is set low enough that a bad first list cannot
produce a meaningful bounce volume. This follows AWS's own guidance to observe new tenants before
enabling automated enforcement.

A tenant is promoted to Standard once it has sent cleanly over a defined volume and window.
Promotion is automatic on those criteria.

A tenant is demoted to Strict automatically the moment a reputation finding opens against it, and
it stays there until the finding is resolved and a human reviews it. Promotion out of that state is
manual. We do not have an automatic path back.

CIRCUIT BREAKERS

We subscribe to the SES EventBridge events on the default bus and act on all four detail-types:

- Sending Status Disabled and Sending Status Enabled. We mirror the status into our own database
  within one processing cycle. Our send relay reads that mirrored status before every send, so a
  paused tenant fails closed at our edge without an AWS round trip, and the failure names the
  recorded cause.
- Advisor Recommendation Status Open and Closed. An open finding records its type, impact and
  description and demotes the tenant to Strict.

A paused tenant has no escape hatch. Our product supports customer-supplied email providers as an
alternative, and a tenant paused for reputation is blocked from rerouting through one. Nothing is
silently retried elsewhere.

Bulk list import is blocked entirely for any tenant below the established tier. The scraped-list
blast is the specific event that damages a shared pool fastest, and a tenant with no sending history
cannot perform one through our product.

We suspend a tenant ourselves, immediately and without prior notice, when its bounce or complaint
rate crosses the levels at which AWS would place an account under review. We would rather cut off
one tenant early than defend an account review later. The customer receives a notice that states
the cause, the measured rate, and the specific clause of our Acceptable Use Policy that was
breached. Reinstatement is a human review, never an automatic unpause on request.

CONSENT AND COMPLAINT HANDLING

These are enforced by the software, at one choke point that every send passes through, not by
policy alone:

- Every send checks the recipient's preference and suppression state before dispatch. An
  unsubscribed or suppressed recipient produces a recorded skip, not a delivery.
- Every send carries List-Unsubscribe and List-Unsubscribe-Post: List-Unsubscribe=One-Click
  headers pointing at a real, honored endpoint, alongside an in-body unsubscribe link.
- Recipients get a hosted preference center with per-category opt-out, not just a global one.
- A per-recipient frequency cap limits how much mail one person can receive in a window,
  independently of how many journeys target them.
- Bounces and complaints arrive back over a signed webhook, are written against the individual send
  record, and add the address to that tenant's tenant-scoped suppression list automatically.
- Our Acceptable Use Policy requires direct recipient permission, prohibits purchased, rented,
  scraped and appended lists, and is enforceable per clause. It is incorporated into the Cloud
  terms, and the terms warrant recipient consent as the customer's obligation.

Bounce and complaint processing is not something we plan to add. It is how sending already works in
this product, including for customers who send through other providers today.

AUTHENTICATION

Every customer domain is verified with 2048-bit BYODKIM. The customer places one DNS TXT record on a
domain they control, which is itself proof of control. No send is possible from an unverified
identity. DMARC passes on DKIM alignment. Customers who want a branded return path add a custom
MAIL FROM subdomain of their own domain.

VOLUME AND QUOTA

We are asking for a modest opening quota and expect to grow it against a real sending record.

Requested for <REGION>:
  50,000 messages per 24-hour period
  14 messages per second

That is sized against our actual plan limits, not a projection. Our plans cap email at 1,000 per
14-day trial, 10,000 per month on the self-serve plan, and 100,000 per month on the dedicated plan.
The largest single tenant we can currently sell is therefore about 3,300 messages a day. The
requested quota covers our first cohort with headroom and no more.

Ramp plan. We will request the next increase only when all three hold for seven consecutive days:
sustained daily volume above 60% of the current quota, account bounce rate below 2%, and account
complaint rate below 0.05%. The steps we anticipate are 50,000, then 200,000, then 1,000,000
messages per 24-hour period. Each request will cite the tenant count, the aggregate rates, and the
per-tenant distribution behind them.

CONTACTS

Operational and abuse contact: abuse@hogsend.com
Account contact: hello@hogsend.com

Both are monitored. We will respond to any Trust and Safety case on this account the same working
day.
```

Replace `<REGION>` with `us-east-1` or `eu-west-1` before sending. The rest of the text is identical
across both cases.

> **Settled 2026-08-12:** 50,000 per 24 hours and 14 per second — the standard production default,
> deliberately unambitious. A larger opening ask invites scrutiny we do not need, and the ramp story
> is stronger with a real record behind it.

> **Settled 2026-08-12:** the ramp triggers stand as written (60% of quota for 7 days, bounce below
> 2%, complaint below 0.05%). They are stricter than AWS's own thresholds on purpose, because they
> are what we volunteer to be judged against.

### After the reply

AWS gives an initial response within 24 hours. Record the outcome per region in the plan stack's
`DECISIONS.md §7` and flip PRD 01 from `[~]` to `[x]` only when both regions are granted. If AWS asks a follow-up, the answer is almost certainly already in the body
above; quote it rather than paraphrasing, so the case does not accumulate two versions of the
sending model.

---

## Appendix A: IAM policy for `hogsend-cloud-relay`

The control plane runs on Railway, which is not AWS compute, so there is no role to assume. The
credential is a static access key on an IAM user, `hogsend-cloud-relay`, holding exactly one
customer-managed policy. See `DECISIONS.md §7.1`.

The policy grants the verbs of the PRD 02 contract and nothing else. There is no `ses:*`. Every
action name below was confirmed against a primary AWS source; see Appendix B. Email RECEIVING needs
four further grants, which are a separate statement set and are documented under "The receiving
grant" below.

`ses:GetTenant`, `ses:GetReputationEntity` and `ses:GetAccount` were added to PRD 02's contract
after this appendix was first drafted; see "Resolved after this appendix was drafted" below.

`ses:GetAccount` is the one action here whose ABSENCE is silent rather than loud: provisioning reads
it to decide whether the account can actually send, and a client that cannot read it fails CLOSED —
every new instance stays on its own email provider and Hogsend Email is never activated. That is the
safe direction, and it is also indistinguishable from "production access was never granted" unless
somebody reads the recorded reason on the provision.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HogsendEmailRelay",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:CreateTenant",
        "ses:GetTenant",
        "ses:DeleteTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
        "ses:PutTenantSuppressionAttributes",
        "ses:CreateConfigurationSet",
        "ses:DeleteConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:UpdateConfigurationSetEventDestination",
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:DeleteEmailIdentity",
        "ses:UpdateReputationEntityPolicy",
        "ses:UpdateReputationEntityCustomerManagedStatus",
        "ses:GetReputationEntity",
        "ses:ListRecommendations",
        "ses:GetAccount"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "eu-west-1"]
        }
      }
    }
  ]
}
```

`Resource: "*"` with a region condition is deliberate. The resources this policy touches are named
at provision time (`env-<environment-id>` tenants, customer-owned domains as identities), so an ARN
pattern written now would be a guess, and a wrong ARN pattern fails as `AccessDenied` during a
customer's provisioning run. The region condition is the narrowing that is safe to write today: it
holds the credential to the two regions in `DECISIONS §3.3` and makes a leaked key useless
everywhere else. Narrow to ARN patterns once PRD 06 locks the tenant and configuration-set naming,
using these formats:

| Resource | ARN format |
| --- | --- |
| tenant | `arn:${Partition}:ses:${Region}:${Account}:tenant/${TenantName}/${TenantId}` |
| configuration-set | `arn:${Partition}:ses:${Region}:${Account}:configuration-set/${ConfigurationSetName}` |
| identity | `arn:${Partition}:ses:${Region}:${Account}:identity/${IdentityName}` |
| reputation-policy | `arn:${Partition}:ses:${Region}:aws:reputation-policy/${ReputationPolicyName}` |

`ses:SendEmail` and `ses:SendBulkEmail` also support a `ses:TenantName` condition key. A
`StringLike` condition on `env-*` would stop a leaked key sending outside a Hogsend-minted tenant.
It is not in the policy above because a condition key that does not match the value the relay
actually sends kills every send in the account at once, and that is worth proving against a live
tenant first. Add it after PRD 06 sends its first real message.

### The receiving grant (PRD 16)

Inbound replies need permissions the sending policy above does not carry, and they are held in a
SEPARATE statement set — `apps/cloud/scripts/aws-bootstrap-events.sh` applies them as an inline
policy on the same `hogsend-cloud-relay` user, and that script is the source of truth this appendix
mirrors. They are separate rather than merged because the block above is the audited artefact behind
the sending pipeline, and widening it would make one grant answer for two features with very
different blast radii.

Receiving does NOT need a new send action: the mandatory forward to the customer's human address
(PRD 16 task 6) goes out through `ses:SendEmail`, already granted above, under the customer's own
tenant and their own verified domain.

```json
{
  "Sid": "SesInboundReceiptRules",
  "Effect": "Allow",
  "Action": [
    "ses:CreateReceiptRuleSet",
    "ses:DescribeReceiptRuleSet",
    "ses:DeleteReceiptRuleSet",
    "ses:DescribeActiveReceiptRuleSet",
    "ses:SetActiveReceiptRuleSet",
    "ses:CreateReceiptRule",
    "ses:UpdateReceiptRule",
    "ses:DescribeReceiptRule",
    "ses:DeleteReceiptRule"
  ],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "aws:RequestedRegion": ["us-east-1", "eu-west-1"] }
  }
},
{
  "Sid": "SesInboundMessageRead",
  "Effect": "Allow",
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::hogsend-ses-inbound/inbound/*"
},
{
  "Sid": "SesInboundTopicSubscriptions",
  "Effect": "Allow",
  "Action": [
    "sns:Subscribe",
    "sns:Unsubscribe",
    "sns:GetTopicAttributes",
    "sns:ListSubscriptionsByTopic"
  ],
  "Resource": [
    "arn:aws:sns:us-east-1:<account>:hogsend-ses-inbound",
    "arn:aws:sns:eu-west-1:<account>:hogsend-ses-inbound",
    "arn:aws:sns:us-east-1:<account>:hogsend-ses-inbound:*",
    "arn:aws:sns:eu-west-1:<account>:hogsend-ses-inbound:*"
  ]
}
```

**Nine actions for eight seam verbs.** The `SesInboundClient` seam (`apps/cloud/src/ses/inbound`) has
eight verbs; `putRule` is a create-or-update, so it needs both `ses:CreateReceiptRule` and
`ses:UpdateReceiptRule` — the same shape `putEventDestination` has above. Every receipt-rule verb is
SES **v1** (`@aws-sdk/client-ses`); the v2 API has no email receiving at all, which is why this is a
second client and a second seam rather than more verbs on the nineteen.

**`s3:GetObject` and nothing more.** SES writes the raw MIME; the relay only READS it. No
`s3:PutObject`, because the write is SES's own under a bucket policy, and no `s3:DeleteObject`,
because retention is a lifecycle rule on the bucket rather than a credential the control plane
carries. The object-key prefix in the resource ARN is pinned to `INBOUND_OBJECT_KEY_PREFIX` in code,
and the two are asserted equal by a test — a drift there stores every reply perfectly and makes the
read `AccessDenied`.

**Subscribe/Unsubscribe, never Publish.** The relay never publishes to the inbound topic (SES does);
it attaches and detaches a receiving endpoint. Each topic is named TWICE — the topic ARN and
`<topic>:*` — because `Subscribe` is authorized against the topic while `Unsubscribe` takes a
SubscriptionArn, which AWS documents as the topic ARN with a uuid appended; which of the two IAM
matches against is not stated anywhere we could find, and the cost of guessing wrong is a stranded
live subscription.

**`Resource: "*"` on the receipt-rule statement**, for the same reason as the sending policy plus one
more: we could not confirm whether these actions accept a resource-level ARN, because AWS's Service
Authorization Reference page for SES is client-rendered and would not load, and the only receipt-rule
ARN in AWS's own docs (`arn:aws:ses:<region>:<account>:receipt-rule-set/<set>:receipt-rule/<rule>`)
appears there as an `AWS:SourceArn` CONDITION value on resource policies, which is a different thing.
The region condition is the tight scoping that can be stated honestly today.

**What is NOT here, and belongs with the resources instead.** SES itself needs permission to WRITE to
the bucket and PUBLISH to the topic. Those are RESOURCE policies on the bucket and the topic, not
grants on this user, and they are created with those resources.

### Resolved after this appendix was drafted

Drafting this policy surfaced three defects in PRD 02's verb table. All three were verified against
AWS's own API reference and corrected in the plan stack on 2026-08-10, and the JSON above already
reflects the corrections. Recorded here so the policy and the plan are demonstrably the same list.

1. **The count was wrong.** PRD 02's prose said sixteen verbs; the table listed seventeen; the
   correct number after the two additions below is **nineteen**.
2. **`ses:GetTenant` added.** `CreateTenant` returns the tenant ARN only on the call that creates
   it, so PRD 02's own idempotency criterion (a second `createTenant` returns the existing tenant)
   was unimplementable without a read-back, and both reputation writes address the tenant by ARN.
3. **`ses:GetReputationEntity` added.** It is the reconciliation path for a missed EventBridge
   event. Without it, a missed pause leaves a tenant looking active in our mirrored status, and
   since the relay reads that mirror, the failure mode is fail-OPEN.

Still excluded, deliberately:

- **`ses:ListTenants`.** Orphan detection after a failed teardown. Our own database is the
  authoritative environment list, teardown is already tolerant of already-absent resources, and an
  orphaned tenant costs $0.005 a month. Add it if orphans ever show up in practice.

---

## Appendix B: action-name verification

Every action name in Appendix A was read from AWS's own machine-readable service reference for
`ses` (`https://servicereference.us-east-1.amazonaws.com/v1/ses/ses.json`, version `v1.4`, retrieved
2026-08-10), and cross-checked against the SESv2 API operation list
(`https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Operations.html`). No name was inferred
from an SDK method name.

| PRD 02 verb | IAM action | Confirmed |
| --- | --- | --- |
| `sendEmail` | `ses:SendEmail` | yes |
| `sendBatch` | `ses:SendEmail` (see note 0) | yes |
| `createTenant` | `ses:CreateTenant` | yes |
| `getTenant` | `ses:GetTenant` | yes |
| `deleteTenant` | `ses:DeleteTenant` | yes |
| `associateResource` | `ses:CreateTenantResourceAssociation` | yes |
| `disassociateResource` | `ses:DeleteTenantResourceAssociation` | yes |
| `putSuppressionScope` | `ses:PutTenantSuppressionAttributes` | yes, see note 1 |
| `createConfigurationSet` | `ses:CreateConfigurationSet` | yes |
| `deleteConfigurationSet` | `ses:DeleteConfigurationSet` | yes |
| `putEventDestination` | `ses:Create…` + `ses:UpdateConfigurationSetEventDestination` | yes, see note 2 |
| `createIdentity` | `ses:CreateEmailIdentity` | yes |
| `getIdentity` | `ses:GetEmailIdentity` | yes |
| `setMailFrom` | `ses:PutEmailIdentityMailFromAttributes` | yes |
| `deleteIdentity` | `ses:DeleteEmailIdentity` | yes |
| `setReputationPolicy` | `ses:UpdateReputationEntityPolicy` | yes, see note 3 |
| `setTenantSendingStatus` | `ses:UpdateReputationEntityCustomerManagedStatus` | yes, see note 3 |
| `getReputationEntity` | `ses:GetReputationEntity` | yes |
| `listRecommendations` | `ses:ListRecommendations` | yes |
| `getAccount` | `ses:GetAccount` | yes, see note 4 |

Twenty verbs, twenty-one IAM actions: `putEventDestination` needs both the create and the update
action because it is implemented as create-then-update-on-already-exists (note 2).

**Note 0.** `ses:SendBulkEmail` is deliberately NOT granted. `sendBatch` fans out one `SendEmail`
per message rather than calling `SendBulkEmail`, because `BulkEmailContent` carries a TEMPLATE and
nothing else, and Hogsend sends per-recipient HTML that the engine has already rendered. Granting an
action we never call would contradict the point of a narrow policy.

**Note 1.** `putSuppressionScope` reads like a configuration-set operation and is not one.
`SuppressionScope: TENANT` is set by `PutTenantSuppressionAttributes`, which takes `TenantName`,
`SuppressionScope` (`ACCOUNT` or `TENANT`) and `SuppressedReasons` (`BOUNCE`, `COMPLAINT`). The
configuration-set operation with a similar name, `PutConfigurationSetSuppressionOptions`, sets the
suppressed reasons on a configuration set and cannot set tenant scope. PRD 06 needs the tenant one.
Source: `https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutTenantSuppressionAttributes.html`.

**Note 2.** SESv2 has both `CreateConfigurationSetEventDestination` and
`UpdateConfigurationSetEventDestination`, and no single `Put` operation. PRD 02's `putEventDestination`
is therefore implemented as create-then-update-on-already-exists, so a provisioning re-drive
converges instead of throwing, and the policy grants **both** actions. Granting only the create
action would make every retried provision fail at exactly the step PRD 06 requires to be idempotent.

**Note 3.** Both reputation writes are `RESOURCE`-type reputation entity operations addressed by
the tenant ARN. Confirmed shapes:

```bash
aws sesv2 update-reputation-entity-policy \
  --reputation-entity-type RESOURCE \
  --reputation-entity-reference "arn:aws:ses:us-east-1:<account>:tenant/<name>/<id>" \
  --reputation-entity-policy "arn:aws:ses:us-east-1:aws:reputation-policy/standard"

aws sesv2 update-reputation-entity-customer-managed-status \
  --reputation-entity-type RESOURCE \
  --reputation-entity-reference "arn:aws:ses:us-east-1:<account>:tenant/<name>/<id>" \
  --sending-status DISABLED
```

`ReputationEntityType` currently accepts `RESOURCE` only. The reputation policy is itself an
AWS-owned ARN (`arn:aws:ses:${Region}:aws:reputation-policy/${name}`), so
`ses:UpdateReputationEntityPolicy` needs both the tenant ARN and that policy ARN in scope, which is
another reason `Resource: "*"` stands until PRD 06 proves a narrower set.
Sources: `https://docs.aws.amazon.com/ses/latest/dg/tenants.html`,
`https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_UpdateReputationEntityPolicy.html`.

**Note 4.** `ses:GetAccount` is a READ of the account's own state — production access, account-level
sending, quota — and it is the gate on activating Hogsend Email at all: sending is only offered to a
customer once `ProductionAccessEnabled` is true, which is a fact only AWS can report. It was granted
to `hogsend-cloud-relay` on 2026-08-11 by `apps/cloud/scripts/aws-bootstrap-events.sh` as part of
the additive `HogsendEmailRelayEvents` grant, alongside `ses:ListEmailIdentities`. Verified live the
same day: `prod=false`, sending enabled, 200/day, 1/sec.
Source: `https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html`.

**Unconfirmed:** none. Every action name above appears verbatim in the AWS service reference for
`ses`. If a name later fails with `AccessDenied`, check the region first: the tenant and reputation
entity APIs shipped in August 2025 and regional availability is the likelier cause than a wrong
name.
