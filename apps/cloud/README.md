# Hogsend Cloud — AWS setup

The control plane owns one AWS account for the whole fleet. Customers never hold AWS credentials:
their instance holds a relay token, and every SES call is made here.

This document covers the AWS side. Everything below is done once per account, by a human, and is
already done for account `929600381829`.

## Two identities, and the difference matters

| Identity | Used for | Can |
| --- | --- | --- |
| An administrator (or root) | The one-time setup below | Create buckets, topics and IAM policies |
| IAM user `hogsend-cloud-relay` | Everything at runtime | Send, manage domains, read the inbound spool |

The relay deliberately **cannot** create a bucket or an SNS topic. A service that can mint its own
storage can mint somebody else's, so infrastructure creation stays outside the process that handles
customer traffic. `scripts/setup-ses-inbound.sh` refuses outright if handed the relay credentials
rather than failing part-way through on a permission error.

## One-time setup

Two scripts, in this order. They are split along one line: the first grants ACCESS, the second
creates RESOURCES. Keeping the grants in one place is deliberate — two overlapping IAM policies
drift, and the wider of the two always wins.

```bash
# 1. Event pipeline, reputation circuit breakers, and every relay grant.
CLOUD_PUBLIC_URL=https://cloud.hogsend.com \
  AWS_PROFILE=<admin-profile> ./apps/cloud/scripts/aws-bootstrap-events.sh

# 2. The inbound spool bucket and its topics.
AWS_PROFILE=<admin-profile> ./apps/cloud/scripts/setup-ses-inbound.sh
```

Both are idempotent — every step creates if absent and re-asserts its configuration, so re-running
after a partial failure converges. Neither deletes anything.

`aws-bootstrap-events.sh` creates the `hogsend-ses-events` topics, the EventBridge connection, API
destination and rule that deliver SES reputation events to `/api/email/reputation`, and the inline
policy `HogsendEmailRelayEvents` — which is the artefact quoted verbatim in
`docs/ses-production-access-request.md`. **Re-running it needs the same
`CLOUD_SES_EVENTBRIDGE_SECRET` the control plane is using**, because AWS will not show you the secret
a connection already holds. It is in `apps/cloud/.env.local`.

`setup-ses-inbound.sh` creates the bucket `hogsend-ses-inbound` — all four public-access blocks on,
SSE-S3, seven-day object expiry — and one `hogsend-ses-inbound` SNS topic per region. Both the bucket
and topic policies let `ses.amazonaws.com` write, scoped by `AWS:SourceAccount`, because that service
principal is shared across all of AWS and without the condition another account's SES could write
here.

The bucket name and the `inbound/` key prefix are **not** free choices: the relay is granted
`s3:GetObject` on `hogsend-ses-inbound/inbound/*` and nothing wider, the code writes under
`INBOUND_OBJECT_KEY_PREFIX` (`lib/inbound-domains.ts`), and the production-access request quotes that
exact ARN to AWS. Any other name is a silent 403 at runtime and a false statement in the request.

One bucket but two topics, because S3 is the documented exception to SES's rule that inbound
resources live in the SES endpoint's region.

### The lifecycle rule is the only retention

SES writes the raw MIME; the relay only **reads** it. Nothing deletes an object after a successful
receive — the relay is granted `s3:GetObject` and nothing else, deliberately, so a credential that
ships to the control plane cannot destroy a customer's mail.

That makes the seven-day expiry the real retention policy for raw inbound message bodies, not a
backstop. Changing it changes how long customer mail sits in our account. The parsed message is
already durable in Postgres by then; the object is the original bytes.

### Receipt rules are SES v1

`ses:*ReceiptRule*` has no v2 equivalent, which is why the code carries a second AWS SDK client for
inbound. This is not an oversight to tidy up.

## Environment variables

| Variable | Absent means |
| --- | --- |
| `CLOUD_AWS_ACCESS_KEY_ID` / `CLOUD_AWS_SECRET_ACCESS_KEY` | No AWS: SES tenancies are minted against the in-memory fake and Hogsend Email never activates |
| `CLOUD_SES_SNS_TOPIC_ARN_US` / `_EU` | Provisioning skips the event destination, so no delivery, bounce or complaint events |
| `CLOUD_SES_INBOUND_BUCKET` | Inbound receiving cannot be turned on |
| `CLOUD_SES_INBOUND_TOPIC_ARN_US` / `_EU` | As above |
| `CLOUD_SES_EVENTBRIDGE_SECRET` | Every reputation event is refused |

None of these is a permissive default. An unconfigured ingress **rejects** rather than accepts: with
no topic configured for a region there is no expected `TopicArn` to check against, and with no
EventBridge secret there is nothing to authenticate an event with. An endpoint that accepted anything
until somebody remembered to configure it would be a stop-any-tenant button on the public internet
for exactly as long as that took.

The three inbound variables are **all or none**. A half configuration is treated as absent on
purpose: a bucket with no topic stores a customer's reply where nothing is listening.

Inbound is opt-in per domain regardless, and `Reply-To` — the default for replies — needs none of it.

## Verifying

Read the config back only after proving the access works, because a policy that reads correctly can
still be denied at runtime:

```bash
# As an administrator: write a probe object under the prefix, and clean up after.
aws s3api put-object --bucket hogsend-ses-inbound --key inbound/__probe.txt --body /tmp/probe.txt

# As the relay: read it. This is what the receive path does, and all it may do.
aws s3api get-object --bucket hogsend-ses-inbound --key inbound/__probe.txt /tmp/got.txt

# As the relay: this MUST be denied. The grant stops at the prefix.
aws s3api get-object --bucket hogsend-ses-inbound --key outside.txt /tmp/x

# As an administrator again — the relay cannot delete, by design.
aws s3api delete-object --bucket hogsend-ses-inbound --key inbound/__probe.txt
```

Two traps here. `head-object` on a key that does not exist returns 403, not 404, when the caller has
`s3:GetObject` but not `s3:ListBucket` — S3 refusing to confirm which keys exist, not a permission
failure, so do not use it to test access. And a delete attempted with the relay's credentials will
fail; that is the correct result, not a broken setup.

## Production access

```bash
aws sesv2 get-account --region us-east-1 --query '{prod:ProductionAccessEnabled,quota:SendQuota.Max24HourSend}'
```

Until `ProductionAccessEnabled` is true the account is in the SES sandbox: 200 messages a day, and
only to identities we verified ourselves. Provisioning reads this live and refuses to activate
Hogsend Email for a new environment while it is false, so an instance provisioned during the sandbox
comes up on another provider rather than on a send path that cannot deliver. Production access is
granted per region by an AWS human; the request lives in `docs/ses-production-access-request.md`.
