#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# aws-bootstrap-events.sh — the one ADMIN-credentialed step the email event
# pipeline needs. Run once per AWS account, by the account owner.
#
# ## Why this exists as a script rather than a console runbook
#
# The relay user (`hogsend-cloud-relay`) is deliberately scoped to the PRD 02
# verb list and nothing else, so it cannot create an SNS topic and cannot widen
# its own policy — which is the correct posture for a credential that ships to
# a control plane, and also the reason the event pipeline has never run. The
# gap is exactly two resources and one policy statement. Doing it by hand across
# two regions is six console journeys with a topic-policy JSON blob typed twice;
# doing it here is idempotent, reviewable, and leaves a diff.
#
# ## What it creates
#
#   1. An SNS topic `hogsend-ses-events` in EACH region (us-east-1, eu-west-1).
#   2. A topic access policy on each, letting `ses.amazonaws.com` publish to it
#      — scoped by `AWS:SourceAccount`, so another AWS account cannot aim its
#      SES events at our topic.
#   3. An INLINE policy on the relay user granting subscribe/unsubscribe on
#      those two topics, two read-only SES account verbs, and — separately and
#      additively — the SES **v1** receipt-rule verbs plus the S3 read and SNS
#      subscribe that inbound receiving needs (PRD 16).
#
# It deliberately does NOT create the inbound bucket or the inbound topic. See
# "The three INBOUND statements" below for why, and for the resource policies
# those two will need when they are created.
#
# Step 3 is inline and separately named rather than a new version of the managed
# `HogsendEmailRelay` policy. That is deliberate: the managed policy is the
# audited artefact quoted verbatim in docs/ses-production-access-request.md, and
# a script that rewrites it would silently invalidate the document AWS reviewed.
# An additive, separately-named grant is reversible with one delete and reads
# honestly in the console.
#
# ## Usage
#
#   aws configure           # your ADMIN credentials, not the relay user's
#   apps/cloud/scripts/aws-bootstrap-events.sh
#
#   DRY_RUN=1 apps/cloud/scripts/aws-bootstrap-events.sh   # print, change nothing
#
# Safe to re-run: every step is create-or-update.
# -----------------------------------------------------------------------------
set -euo pipefail

TOPIC_NAME="${TOPIC_NAME:-hogsend-ses-events}"
RELAY_USER="${RELAY_USER:-hogsend-cloud-relay}"
INLINE_POLICY_NAME="${INLINE_POLICY_NAME:-HogsendEmailRelayEvents}"
REGIONS=("us-east-1" "eu-west-1")
DRY_RUN="${DRY_RUN:-}"

# Inbound (PRD 16). Names only — this script does NOT create the bucket or the
# inbound topic, it only grants the relay user access to them. An IAM grant
# naming a resource that does not exist yet is inert and reversible; creating an
# S3 bucket that will hold customers' inbound mail is a decision that belongs
# with the provisioning that uses it, not with a one-shot bootstrap.
INBOUND_TOPIC_NAME="${INBOUND_TOPIC_NAME:-hogsend-ses-inbound}"
INBOUND_BUCKET="${INBOUND_BUCKET:-hogsend-ses-inbound}"
INBOUND_PREFIX="${INBOUND_PREFIX:-inbound/}"

export AWS_PAGER=""

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI not found. brew install awscli" >&2
  exit 1
fi

run() {
  if [[ -n "$DRY_RUN" ]]; then
    echo "  [dry-run] $*"
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------
# Refuse against the relay user itself.
#
# The relay key cannot perform any of this, so running it with the relay
# credentials exported would fail three times with an AccessDenied that reads
# like a bug in the script rather than the wrong credentials. Name it up front.
# ---------------------------------------------------------------------------
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "caller:  ${CALLER_ARN}"
echo "account: ${ACCOUNT_ID}"
echo

if [[ "$CALLER_ARN" == *":user/${RELAY_USER}" ]]; then
  cat >&2 <<EOF
error: these are the RELAY credentials (${RELAY_USER}).

That user is scoped to the SES send/provision verbs on purpose and cannot
create an SNS topic or edit its own policy. Run this with the account owner's
admin credentials instead:

  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  aws configure
EOF
  exit 1
fi

TOPIC_ARNS=()

for region in "${REGIONS[@]}"; do
  echo "=== ${region} ==="

  # create-topic IS the idempotent call: given an existing name it returns the
  # existing ARN and changes nothing, so there is no need to check first.
  if [[ -n "$DRY_RUN" ]]; then
    topic_arn="arn:aws:sns:${region}:${ACCOUNT_ID}:${TOPIC_NAME}"
    echo "  [dry-run] aws sns create-topic --name ${TOPIC_NAME}"
  else
    topic_arn="$(aws sns create-topic \
      --name "$TOPIC_NAME" \
      --region "$region" \
      --query TopicArn --output text)"
  fi
  echo "  topic: ${topic_arn}"
  TOPIC_ARNS+=("$topic_arn")

  # The SourceAccount condition is the part that matters. Without it the policy
  # says "any SES, anywhere, may publish here", and anyone who learns the ARN
  # can inject bounce events into our pipeline — which our ingress trusts to
  # mark sends as permanently failed and to suppress recipients.
  topic_policy="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSESPublish",
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "${topic_arn}",
      "Condition": {
        "StringEquals": { "AWS:SourceAccount": "${ACCOUNT_ID}" }
      }
    }
  ]
}
EOF
)"

  run aws sns set-topic-attributes \
    --topic-arn "$topic_arn" \
    --attribute-name Policy \
    --attribute-value "$topic_policy" \
    --region "$region"
  echo "  policy: SES publish allowed, scoped to account ${ACCOUNT_ID}"
  echo
done

# ---------------------------------------------------------------------------
# The relay grant.
#
# Subscribe/Unsubscribe rather than Publish: the relay never publishes to this
# topic (SES does). It attaches the current run's receiving endpoint and detaches
# it afterwards, which is what makes a tunnelled local proof possible without a
# standing subscription pointing at a URL that stopped existing.
#
# The resource list names each topic TWICE — the topic ARN and `<topic>:*`.
# `Subscribe` is authorized against the topic, but `Unsubscribe` takes a
# SubscriptionArn, which AWS's own API reference documents as the topic ARN with
# a uuid appended (`…:My-Topic:80289ba6-…`). Which of the two IAM matches against
# is not stated anywhere we could find, and the cost of being wrong is asymmetric:
# guessing right saves four characters, guessing wrong strands a live
# subscription pointing at a tunnel that no longer exists, on a topic feeding our
# bounce pipeline. Both entries stay scoped to this one topic.
#
# ses:GetAccount and ses:ListEmailIdentities are read-only and were missing from
# the original 20. Their absence is why the account's sandbox status and quota
# cannot be read by our own tooling today.
#
# ## The three INBOUND statements (PRD 16)
#
# Separate statements, deliberately. The existing two are the audited artefact
# behind the outbound event pipeline; widening either of them to cover receiving
# would make one grant answer for two features with different blast radii.
#
# `SesInboundReceiptRules` grants exactly the nine v1 operations behind the
# eight-verb `SesInboundClient` seam (src/ses/inbound). Note NINE for eight
# verbs: `putRule` is a create-or-update, so it needs both `ses:CreateReceiptRule`
# and `ses:UpdateReceiptRule` — the same shape `putEventDestination` has above.
# Every receipt-rule verb is SES **v1**; the v2 API has no email receiving at all.
#
# `Resource: "*"` with a region condition matches the standard the managed
# `HogsendEmailRelay` policy already sets and states its reasons for. We could
# NOT confirm whether these actions accept a resource-level ARN: AWS's Service
# Authorization Reference page for SES is client-rendered and would not load,
# and the only receipt-rule ARN we found in AWS's own docs
# (`arn:aws:ses:<region>:<account>:receipt-rule-set/<set>:receipt-rule/<rule>`)
# appears there as an `AWS:SourceArn` CONDITION value on resource policies, which
# is a different thing. The region condition is the tight scoping we can state
# honestly; narrowing further is a follow-up once that page can be read.
#
# `SesInboundMessageRead` is s3:GetObject and nothing more. The relay READS the
# stored MIME; it never writes it. SES writes it, as a service principal, under
# a bucket policy (below). No s3:DeleteObject either — retention is a lifecycle
# rule on the bucket, not a credential the control plane carries.
#
# `SesInboundTopicSubscriptions` mirrors the events grant exactly, including
# naming each topic TWICE for the Unsubscribe/SubscriptionArn reason given above.
#
# ## What is NOT here, and belongs with the resources instead
#
# SES itself needs permission to WRITE to the bucket and PUBLISH to the topic.
# Those are RESOURCE policies on the bucket and the topic, not grants on this
# user, so they are created with those resources (PRD 16 task 3). AWS's own
# documented form, for the record, so the next person does not have to re-derive
# it — note it is scoped by BOTH SourceAccount and the receipt-rule SourceArn,
# which is tighter than the AWS:SourceAccount-only standard the events topic
# above uses:
#
#   {
#     "Sid": "AllowSESPuts",
#     "Effect": "Allow",
#     "Principal": { "Service": "ses.amazonaws.com" },
#     "Action": "s3:PutObject",
#     "Resource": "arn:aws:s3:::<bucket>/*",
#     "Condition": { "StringEquals": {
#       "AWS:SourceAccount": "<account>",
#       "AWS:SourceArn": "arn:aws:ses:<region>:<account>:receipt-rule-set/<set>:receipt-rule/<rule>"
#     }}
#   }
#
# A same-account SNS topic needs no such statement per AWS's docs, which give the
# publish policy only for "an Amazon SNS topic that belongs to a different AWS
# account" — but the inbound topic will carry one anyway, matching the events
# topic's AWS:SourceAccount scoping, because an unscoped topic is one leaked ARN
# away from a stranger injecting messages into our receive pipeline.
# ---------------------------------------------------------------------------
echo "=== relay user grant ==="

inline_policy="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SesEventTopicSubscriptions",
      "Effect": "Allow",
      "Action": [
        "sns:Subscribe",
        "sns:Unsubscribe",
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic"
      ],
      "Resource": [
        "arn:aws:sns:us-east-1:${ACCOUNT_ID}:${TOPIC_NAME}",
        "arn:aws:sns:eu-west-1:${ACCOUNT_ID}:${TOPIC_NAME}",
        "arn:aws:sns:us-east-1:${ACCOUNT_ID}:${TOPIC_NAME}:*",
        "arn:aws:sns:eu-west-1:${ACCOUNT_ID}:${TOPIC_NAME}:*"
      ]
    },
    {
      "Sid": "SesAccountVisibility",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:ListEmailIdentities"
      ],
      "Resource": "*"
    },
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
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "eu-west-1"]
        }
      }
    },
    {
      "Sid": "SesInboundMessageRead",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${INBOUND_BUCKET}/${INBOUND_PREFIX}*"
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
        "arn:aws:sns:us-east-1:${ACCOUNT_ID}:${INBOUND_TOPIC_NAME}",
        "arn:aws:sns:eu-west-1:${ACCOUNT_ID}:${INBOUND_TOPIC_NAME}",
        "arn:aws:sns:us-east-1:${ACCOUNT_ID}:${INBOUND_TOPIC_NAME}:*",
        "arn:aws:sns:eu-west-1:${ACCOUNT_ID}:${INBOUND_TOPIC_NAME}:*"
      ]
    }
  ]
}
EOF
)"

run aws iam put-user-policy \
  --user-name "$RELAY_USER" \
  --policy-name "$INLINE_POLICY_NAME" \
  --policy-document "$inline_policy"

echo "  ${RELAY_USER}: inline policy ${INLINE_POLICY_NAME} applied"
echo

echo "=== done ==="
echo
echo "Add these to apps/cloud/.env.local:"
echo
echo "CLOUD_SES_SNS_TOPIC_ARN_US=${TOPIC_ARNS[0]}"
echo "CLOUD_SES_SNS_TOPIC_ARN_EU=${TOPIC_ARNS[1]}"
echo
echo "Inbound (PRD 16): the relay user is now GRANTED against these names, but"
echo "neither resource is created yet — that is PRD 16 task 3's job, together"
echo "with the SES-service bucket and topic policies documented in this script."
echo
echo "  bucket: ${INBOUND_BUCKET} (prefix ${INBOUND_PREFIX})"
echo "  topic:  ${INBOUND_TOPIC_NAME} in each of ${REGIONS[*]}"
