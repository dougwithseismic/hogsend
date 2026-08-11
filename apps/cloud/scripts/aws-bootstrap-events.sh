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
#      those two topics plus two read-only SES account verbs.
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
# ses:GetAccount and ses:ListEmailIdentities are read-only and were missing from
# the original 20. Their absence is why the account's sandbox status and quota
# cannot be read by our own tooling today.
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
        "arn:aws:sns:eu-west-1:${ACCOUNT_ID}:${TOPIC_NAME}"
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
