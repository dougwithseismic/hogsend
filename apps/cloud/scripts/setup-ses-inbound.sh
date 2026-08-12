#!/usr/bin/env bash
#
# One-time AWS setup for SES inbound receiving (PRD 16).
#
# WHY THIS IS A SCRIPT AND NOT PART OF PROVISIONING: everything below is a
# one-per-account admin action, and the control plane deliberately cannot do
# any of it. The relay runs as `hogsend-cloud-relay`, an IAM user with no
# s3:CreateBucket and no sns:CreateTopic — a service that can mint its own
# storage can also mint somebody else's. So this runs ONCE, by a human holding
# admin credentials, and the relay is only ever handed the finished resources.
#
# It is IDEMPOTENT: every step creates-if-absent and re-asserts configuration,
# so re-running after a partial failure is safe. It NEVER deletes anything.
#
#   AWS_PROFILE=<admin-profile> ./apps/cloud/scripts/setup-ses-inbound.sh
#
# At the end it prints the three environment variables to set on the control
# plane. Until all three are set the feature stays off: `resolveInboundStore`
# treats a HALF configuration as absent on purpose, because a bucket with no
# topic stores a customer's reply where nothing is listening.

set -euo pipefail

# S3 buckets are the ONE exception to SES's same-region rule — AWS's own words:
# "With the exception of Amazon S3 buckets, all of the AWS resources that you
# use for receiving email with SES have to be in the same AWS Region as the SES
# endpoint." So: one bucket, but one topic PER REGION.
REGIONS=("us-east-1" "eu-west-1")
BUCKET_REGION="us-east-1"
TOPIC_NAME="hogsend-ses-inbound"

# Objects are a SPOOL, not an archive. The receive path fetches the MIME and
# deletes it once stored, so anything still here is a failure that was not
# retried. Seven days is long enough to debug one, short enough that a
# customer's mail body is not sitting in our account indefinitely.
SPOOL_EXPIRY_DAYS=7

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }

say "Checking credentials"
IDENTITY=$(aws sts get-caller-identity --output json)
ACCOUNT=$(printf '%s' "$IDENTITY" | grep -o '"Account": *"[0-9]*"' | grep -o '[0-9]\{6,\}')
ARN=$(printf '%s' "$IDENTITY" | sed -n 's/.*"Arn": *"\([^"]*\)".*/\1/p')
ok "account $ACCOUNT as $ARN"

if printf '%s' "$ARN" | grep -q 'user/hogsend-cloud-relay'; then
  echo
  echo "REFUSING: these are the RELAY credentials." >&2
  echo "The relay cannot create infrastructure by design. Re-run with an" >&2
  echo "administrator profile: AWS_PROFILE=<admin> $0" >&2
  exit 1
fi

# These two names are NOT free choices. `aws-bootstrap-events.sh` already grants
# the relay `s3:GetObject` on `hogsend-ses-inbound/inbound/*`, the code writes
# under `INBOUND_OBJECT_KEY_PREFIX` (`lib/inbound-domains.ts`), and
# `docs/ses-production-access-request.md` quotes that exact ARN to AWS. Anything
# else here is a silent 403 at runtime and a false statement in the request.
BUCKET="hogsend-ses-inbound"
PREFIX="inbound/"

say "S3 bucket: ${BUCKET} (${BUCKET_REGION})"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  ok "already exists"
else
  # us-east-1 is the one region that REJECTS an explicit LocationConstraint.
  if [ "$BUCKET_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region us-east-1 >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$BUCKET_REGION" \
      --create-bucket-configuration "LocationConstraint=${BUCKET_REGION}" >/dev/null
  fi
  ok "created"
fi

# Customers' inbound mail. There is no version of this that is public.
# All four, including BlockPublicPolicy. The bucket policy below grants a
# SERVICE principal, which AWS does not classify as public, so blocking public
# policies does not reject it — it only stops a future `Principal: "*"` from
# ever being attached here.
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
ok "public access blocked (all four)"

# SSE-S3 (AES256) rather than SSE-KMS: SES can write to an SSE-S3 bucket with
# no extra grant, whereas SSE-KMS additionally requires kms:GenerateDataKey for
# the SES service principal and a customer-managed key to administer. Not worth
# it for a seven-day spool.
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' >/dev/null
ok "SSE-S3 encryption on"

aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "$(cat <<JSON
{"Rules":[{
  "ID":"expire-inbound-spool",
  "Status":"Enabled",
  "Filter":{"Prefix":""},
  "Expiration":{"Days":${SPOOL_EXPIRY_DAYS}},
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}
}]}
JSON
)" >/dev/null
ok "lifecycle: objects expire after ${SPOOL_EXPIRY_DAYS} days"

# SES writes here. Scoped by SourceAccount so another AWS account's SES cannot
# use this bucket as a dumping ground even though the service principal is
# shared across all of AWS.
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{
  "Sid":"AllowSESInboundPuts",
  "Effect":"Allow",
  "Principal":{"Service":"ses.amazonaws.com"},
  "Action":"s3:PutObject",
  "Resource":"arn:aws:s3:::${BUCKET}/${PREFIX}*",
  "Condition":{"StringEquals":{"AWS:SourceAccount":"${ACCOUNT}"}}
}]}
JSON
)" >/dev/null
ok "bucket policy allows SES to write"

TOPIC_ARNS=()
for REGION in "${REGIONS[@]}"; do
  say "SNS topic in ${REGION}"
  # create-topic IS the idempotent call: it returns the existing ARN unchanged.
  TOPIC_ARN=$(aws sns create-topic --name "$TOPIC_NAME" --region "$REGION" \
    --query 'TopicArn' --output text)
  ok "$TOPIC_ARN"

  aws sns set-topic-attributes --region "$REGION" --topic-arn "$TOPIC_ARN" \
    --attribute-name Policy --attribute-value "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{
  "Sid":"AllowSESInboundPublish",
  "Effect":"Allow",
  "Principal":{"Service":"ses.amazonaws.com"},
  "Action":"sns:Publish",
  "Resource":"${TOPIC_ARN}",
  "Condition":{"StringEquals":{"AWS:SourceAccount":"${ACCOUNT}"}}
}]}
JSON
)" >/dev/null
  ok "topic policy allows SES to publish"
  TOPIC_ARNS+=("$TOPIC_ARN")
done

say "Relay IAM policy"
# NOT granted here, on purpose. `aws-bootstrap-events.sh` already attaches the
# inline policy `HogsendEmailRelayEvents`, which covers the inbound S3 read and
# the SNS subscribe against these exact names, and that policy is the artefact
# quoted in docs/ses-production-access-request.md. A second overlapping grant
# from this script is how the two silently drift apart, and the wider of the
# two always wins — so this script creates RESOURCES and that one grants ACCESS.
ok "left to aws-bootstrap-events.sh (HogsendEmailRelayEvents)"
echo
echo "  If the relay gets 403 reading the spool, run that script — it grants"
echo "  s3:GetObject on ${BUCKET}/${PREFIX}* and nothing wider."

say "Set these on the control plane, then redeploy"
echo "CLOUD_SES_INBOUND_BUCKET=${BUCKET}"
echo "CLOUD_SES_INBOUND_TOPIC_ARN_US=${TOPIC_ARNS[0]}"
echo "CLOUD_SES_INBOUND_TOPIC_ARN_EU=${TOPIC_ARNS[1]}"
echo
echo "All three, or none: a half configuration is treated as absent, because a"
echo "bucket with no topic stores a customer's reply where nothing is listening."
