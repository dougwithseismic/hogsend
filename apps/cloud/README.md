# Hogsend Cloud — AWS setup

The control plane owns one AWS account for the whole fleet. Customers never hold AWS credentials:
their instance holds a relay token, and every SES call is made here.

This document covers the AWS side. Everything below is done once per account, by a human, and is
already done for account `929600381829`.

## Two identities, and the difference matters

| Identity | Used for | Can |
| --- | --- | --- |
| An administrator (or root) | The one-time setup below | Create buckets, topics and IAM policies |
| IAM user `hogsend-cloud-relay` | Everything at runtime | Send, manage domains, drain the inbound spool |

The relay deliberately **cannot** create a bucket or an SNS topic. A service that can mint its own
storage can mint somebody else's, so infrastructure creation stays outside the process that handles
customer traffic. `scripts/setup-ses-inbound.sh` refuses outright if handed the relay credentials
rather than failing part-way through on a permission error.

## One-time setup

```bash
AWS_PROFILE=<admin-profile> ./apps/cloud/scripts/setup-ses-inbound.sh
```

Idempotent: every step creates if absent and re-asserts its configuration, so re-running after a
partial failure converges. It never deletes anything. It creates:

- **One S3 bucket**, `hogsend-ses-inbound-<account-id>`. All four public-access blocks on, SSE-S3
  encryption, seven-day object expiry, and a policy letting `ses.amazonaws.com` write — scoped by
  `AWS:SourceAccount`, because that service principal is shared across all of AWS and without the
  condition another account's SES could write here.
- **Two SNS topics**, one per region, each allowing SES to publish under the same condition.
- **An inline IAM policy** on `hogsend-cloud-relay` granting `s3:GetObject` + `s3:DeleteObject` on
  the bucket and the SES v1 receipt-rule verbs.

One bucket but two topics, because S3 is the documented exception to SES's rule that inbound
resources live in the SES endpoint's region.

### The bucket is a spool, not an archive

The receive path fetches each message and deletes it once stored. That is why the relay holds
`s3:DeleteObject`, and why the seven-day lifecycle rule is a backstop for failures rather than the
normal path — anything still in the bucket is a receive that did not complete.

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
# As an administrator: write a probe object.
aws s3api put-object --bucket hogsend-ses-inbound-<account-id> --key __probe.txt --body /tmp/probe.txt

# As the relay: read it, then delete it. This is the sequence the receive path performs.
aws s3api get-object --bucket hogsend-ses-inbound-<account-id> --key __probe.txt /tmp/got.txt
aws s3api delete-object --bucket hogsend-ses-inbound-<account-id> --key __probe.txt
```

Note that `head-object` on a key that does not exist returns 403, not 404, when the caller has
`s3:GetObject` but not `s3:ListBucket`. That is S3 refusing to confirm which keys exist, not a
permission failure — do not use it to test access.

## Production access

```bash
aws sesv2 get-account --region us-east-1 --query '{prod:ProductionAccessEnabled,quota:SendQuota.Max24HourSend}'
```

Until `ProductionAccessEnabled` is true the account is in the SES sandbox: 200 messages a day, and
only to identities we verified ourselves. Provisioning reads this live and refuses to activate
Hogsend Email for a new environment while it is false, so an instance provisioned during the sandbox
comes up on another provider rather than on a send path that cannot deliver. Production access is
granted per region by an AWS human; the request lives in `docs/ses-production-access-request.md`.
