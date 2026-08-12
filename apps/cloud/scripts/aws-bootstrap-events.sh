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
#   4. The REPUTATION half (PRD 08): in EACH region, an EventBridge rule on the
#      DEFAULT bus matching `aws.ses` and the four detail-types the control
#      plane consumes, a connection holding the shared secret, an API
#      destination aimed at `<CLOUD_PUBLIC_URL>/api/email/reputation`, and the
#      target that joins them — plus the one IAM role a rule needs to be allowed
#      to invoke an API destination at all.
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
# Step 4 adds NOTHING to the relay user. The reconciliation read the reputation
# sweep makes is `ses:GetReputationEntity`, which the audited managed policy
# already grants; and the rule, connection and destination are account
# infrastructure the relay must never be able to touch — a credential that ships
# to a control plane and can rewrite the endpoint SES's pauses are delivered to
# is a credential that can silence its own suspensions.
#
# ## Usage
#
#   aws configure           # your ADMIN credentials, not the relay user's
#   CLOUD_PUBLIC_URL=https://cloud.example.com \
#     apps/cloud/scripts/aws-bootstrap-events.sh
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

# ---------------------------------------------------------------------------
# The reputation pipeline (PRD 08).
#
# The names are fixed rather than derived, because every one of them is an
# idempotency key: re-running this script must converge on the SAME rule, not
# accumulate a second one alongside it quietly double-delivering every pause.
#
# `EVENTBRIDGE_SECRET_HEADER` and the four detail-types are DUPLICATED from
# `src/eventbridge/verify.ts` and `src/eventbridge/events.ts`. A shell script
# cannot import them, and the duplication is checked rather than trusted:
# `src/__tests__/aws-bootstrap-events.test.ts` reads this script's real argv
# through a stubbed `aws` and asserts both against the TypeScript constants, so
# a rename there fails a test here rather than silently narrowing what SES is
# allowed to tell us.
# ---------------------------------------------------------------------------
RULE_NAME="${RULE_NAME:-hogsend-ses-reputation}"
CONNECTION_NAME="${CONNECTION_NAME:-hogsend-control-plane}"
DESTINATION_NAME="${DESTINATION_NAME:-hogsend-ses-reputation}"
INVOKE_ROLE_NAME="${INVOKE_ROLE_NAME:-HogsendEventBridgeInvoke}"
INVOKE_POLICY_NAME="${INVOKE_POLICY_NAME:-HogsendInvokeApiDestination}"
TARGET_ID="${TARGET_ID:-control-plane}"
EVENTBRIDGE_SECRET_HEADER="x-hogsend-eventbridge-secret"
REPUTATION_PATH="/api/email/reputation"
SES_EVENT_SOURCE="aws.ses"
SES_DETAIL_TYPES='["Sending Status Disabled","Sending Status Enabled","Advisor Recommendation Status Open","Advisor Recommendation Status Closed"]'

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

# Does this resource already exist? Returns 0 when it does, 1 when AWS
# POSITIVELY answered "no such thing". Any other failure — AccessDenied, a
# throttle, a network fault — STOPS the run: treating it as "absent" would
# send the script on to create something that may well exist, and worse, to
# decide the secret question below on a fact it never actually learned. The
# CLI names a missing resource in the error body; the exit code alone cannot
# tell "not there" from "not allowed to ask".
#
# Under DRY_RUN the probe is not made either, and the answer is always "no".
# That is deliberate: a dry run is a transcript of a FIRST run, and probing a
# live account to decide which half of the transcript to print would make the
# output depend on which account the credentials happened to point at.
exists() {
  if [[ -n "$DRY_RUN" ]]; then
    echo "  [dry-run] $*"
    return 1
  fi
  local output
  if output="$("$@" 2>&1)"; then
    return 0
  fi
  case "$output" in
    *ResourceNotFoundException* | *NotFoundException* | *NoSuchEntity*)
      return 1 ;;
  esac
  echo "error: probe failed, and not with a not-found: $*" >&2
  echo "$output" >&2
  exit 1
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

# ---------------------------------------------------------------------------
# The endpoint SES's reputation events are delivered to.
#
# Read from the environment rather than defaulted, and REFUSED unless it is a
# public https origin. `src/env.ts` defaults `CLOUD_PUBLIC_URL` to
# `http://localhost:3004` for local boots, and an API destination aimed there is
# the worst possible outcome of running this script: every AWS resource exists,
# the rule reports itself as ENABLED in the console, and every pause AWS ever
# publishes is delivered into a black hole. A refusal here is a typo; a wrong
# endpoint is a fail-OPEN nobody notices until a suspension does not arrive.
# ---------------------------------------------------------------------------
CONTROL_PLANE_URL="${CLOUD_PUBLIC_URL:-}"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL%/}"

if [[ "$CONTROL_PLANE_URL" != https://* ]]; then
  cat >&2 <<EOF
error: CLOUD_PUBLIC_URL must be the control plane's PUBLIC https origin.

EventBridge POSTs each SES reputation event to <CLOUD_PUBLIC_URL>${REPUTATION_PATH}
from AWS's own network, so localhost and plain http cannot work. Re-run with
the deployed origin:

  CLOUD_PUBLIC_URL=https://cloud.example.com $0

  (got: ${CLOUD_PUBLIC_URL:-<unset>})
EOF
  exit 1
fi

REPUTATION_ENDPOINT="${CONTROL_PLANE_URL}${REPUTATION_PATH}"

# ---------------------------------------------------------------------------
# The shared secret, decided ONCE for both regions.
#
# ONE secret, mirroring `CLOUD_SES_EVENTBRIDGE_SECRET` in `src/env.ts`: a
# reputation event names its own tenant and the tenant resolves to the region,
# so there is nothing regional for the credential to separate.
#
# AWS never reads a connection's API key back — it is write-only, by design. So
# the three states are decided here rather than per region, and the fourth is
# refused:
#
#   - the operator passed one → it is applied to both regions (a rotation);
#   - both connections exist and no value was passed → they are LEFT ALONE.
#     Generating a fresh one would silently rotate the secret away from the
#     value the deployed control plane is holding, and every event after that
#     would 403;
#   - neither exists → one is generated and printed once, to paste;
#   - one exists and one does not, with nothing passed → REFUSED. Whatever we
#     did next would leave the two regions signing with different values and
#     the control plane holding at most one of them.
# ---------------------------------------------------------------------------
SUPPLIED_SECRET="${CLOUD_SES_EVENTBRIDGE_SECRET:-}"
EVENTBRIDGE_SECRET="$SUPPLIED_SECRET"
CONNECTION_EXISTS=()
CONNECTION_PRESENT_REGIONS=()
connections_present=0
connections_missing=0

for region in "${REGIONS[@]}"; do
  if exists aws events describe-connection \
    --name "$CONNECTION_NAME" \
    --region "$region"; then
    CONNECTION_EXISTS+=("yes")
    CONNECTION_PRESENT_REGIONS+=("$region")
    connections_present=$((connections_present + 1))
  else
    CONNECTION_EXISTS+=("no")
    connections_missing=$((connections_missing + 1))
  fi
done

if [[ -n "$SUPPLIED_SECRET" ]]; then
  SECRET_NOTE="applied to every region from CLOUD_SES_EVENTBRIDGE_SECRET"
elif (( connections_missing == 0 )); then
  SECRET_NOTE="unchanged"
elif (( connections_present > 0 )); then
  cat >&2 <<EOF
error: ${connections_present} of ${#REGIONS[@]} regions already have a
'${CONNECTION_NAME}' connection, and AWS will not show us the secret it holds.

Generating a new one here would leave the two regions authenticating with
different values. Re-run with the secret the control plane is already using —
it is CLOUD_SES_EVENTBRIDGE_SECRET in apps/cloud/.env.local:

  CLOUD_SES_EVENTBRIDGE_SECRET=<that value> $0

If that value is LOST — a first run that failed after creating the connection —
no re-run can recover it: AWS keeps a connection's key write-only. Delete the
stranded connection(s) and re-run, and a fresh secret will be minted for both
regions:

$(for present in "${CONNECTION_PRESENT_REGIONS[@]}"; do
  echo "  aws events delete-connection --name ${CONNECTION_NAME} --region ${present}"
done)
EOF
  exit 1
else
  EVENTBRIDGE_SECRET="$(openssl rand -hex 32)"
  SECRET_NOTE="generated"
  # Printed the moment it exists, BEFORE the first AWS write — not only in the
  # closing summary. AWS stores a connection's key write-only, so if anything
  # below fails partway, this line is the ONLY copy in existence; without it a
  # live connection is stranded holding a secret nobody can read, and the
  # refusal above has nothing it can be re-run with. stderr, so a redirected
  # transcript still puts it in front of the operator.
  if [[ -z "$DRY_RUN" ]]; then
    cat >&2 <<EOF
generated the EventBridge shared secret — SAVE THIS NOW, before the AWS writes
below run. AWS will never show it again:

  CLOUD_SES_EVENTBRIDGE_SECRET=${EVENTBRIDGE_SECRET}

EOF
  fi
fi

# ---------------------------------------------------------------------------
# The role a rule needs in order to invoke an API destination.
#
# EventBridge does not call an API destination on its own authority: the target
# carries a RoleArn, and that role is what holds `events:InvokeApiDestination`.
# One role for the account rather than one per region — IAM is global, and two
# identical roles would be two things to remember to revoke.
#
# The grant names both regions' destinations by wildcard on the NAME, not by
# full ARN, because AWS appends a generated suffix to an API destination's ARN
# that does not exist until the destination does. Scoped to this account, these
# two regions and this one destination name; nothing wider.
#
# The TRUST policy carries no condition, unlike the SNS topic policy above, and
# the asymmetry is deliberate. AWS documents that topic policy's
# `AWS:SourceAccount` form for SES publishing; it documents no equivalent
# condition on an EventBridge target role, and every generated form we could
# find (the CDK's own API-destination target among them) is the bare service
# principal. A condition key EventBridge does not populate would not fail
# loudly — the assume is denied, the rule keeps reporting itself ENABLED, and
# every pause AWS publishes is dropped in silence, which is exactly the
# fail-OPEN this pipeline exists to close. The narrowing therefore lives in the
# PERMISSION policy below, which is the half we can scope with confidence.
# ---------------------------------------------------------------------------
echo "=== eventbridge invoke role ==="

INVOKE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${INVOKE_ROLE_NAME}"

trust_policy="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowEventBridgeAssume",
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)"

invoke_policy="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeReputationDestination",
      "Effect": "Allow",
      "Action": "events:InvokeApiDestination",
      "Resource": [
        "arn:aws:events:us-east-1:${ACCOUNT_ID}:api-destination/${DESTINATION_NAME}/*",
        "arn:aws:events:eu-west-1:${ACCOUNT_ID}:api-destination/${DESTINATION_NAME}/*"
      ]
    }
  ]
}
EOF
)"

# `create-role` is NOT idempotent — it answers EntityAlreadyExists — so unlike
# `sns create-topic` this one has to be asked first.
if exists aws iam get-role --role-name "$INVOKE_ROLE_NAME"; then
  echo "  role: ${INVOKE_ROLE_ARN} (exists)"
  run aws iam update-assume-role-policy \
    --role-name "$INVOKE_ROLE_NAME" \
    --policy-document "$trust_policy"
else
  run aws iam create-role \
    --role-name "$INVOKE_ROLE_NAME" \
    --description "Lets EventBridge invoke the Hogsend reputation API destination" \
    --assume-role-policy-document "$trust_policy"
  echo "  role: ${INVOKE_ROLE_ARN}"
fi

run aws iam put-role-policy \
  --role-name "$INVOKE_ROLE_NAME" \
  --policy-name "$INVOKE_POLICY_NAME" \
  --policy-document "$invoke_policy"
echo "  grant: events:InvokeApiDestination on ${DESTINATION_NAME}, both regions"
echo

TOPIC_ARNS=()
region_index=0

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

  # -- The reputation pipeline (PRD 08) --------------------------------------
  #
  # The connection holds the secret and NOTHING else. Its calls bypass the
  # `run` helper for two reasons — neither of which is "run always echoes":
  # their stdout (the connection ARN) must be CAPTURED, which `run` cannot do,
  # and under DRY_RUN `run` WOULD echo its argv verbatim, and this argv
  # carries the credential — so the dry-run transcript prints the redacted
  # form below instead.
  connection_arn="arn:aws:events:${region}:${ACCOUNT_ID}:connection/${CONNECTION_NAME}"
  auth_parameters="ApiKeyAuthParameters={ApiKeyName=${EVENTBRIDGE_SECRET_HEADER},ApiKeyValue=${EVENTBRIDGE_SECRET}}"
  redacted="ApiKeyAuthParameters={ApiKeyName=${EVENTBRIDGE_SECRET_HEADER},ApiKeyValue=<redacted>}"

  if [[ "${CONNECTION_EXISTS[$region_index]}" == "no" ]]; then
    if [[ -n "$DRY_RUN" ]]; then
      echo "  [dry-run] aws events create-connection --name ${CONNECTION_NAME} --authorization-type API_KEY --auth-parameters ${redacted} --region ${region}"
    else
      connection_arn="$(aws events create-connection \
        --name "$CONNECTION_NAME" \
        --description "Authenticates Hogsend reputation deliveries to the control plane" \
        --authorization-type API_KEY \
        --auth-parameters "$auth_parameters" \
        --region "$region" \
        --query ConnectionArn --output text)"
    fi
    echo "  connection: ${CONNECTION_NAME} (created, secret ${SECRET_NOTE})"
  elif [[ -n "$SUPPLIED_SECRET" ]]; then
    if [[ -n "$DRY_RUN" ]]; then
      echo "  [dry-run] aws events update-connection --name ${CONNECTION_NAME} --authorization-type API_KEY --auth-parameters ${redacted} --region ${region}"
    else
      connection_arn="$(aws events update-connection \
        --name "$CONNECTION_NAME" \
        --authorization-type API_KEY \
        --auth-parameters "$auth_parameters" \
        --region "$region" \
        --query ConnectionArn --output text)"
    fi
    echo "  connection: ${CONNECTION_NAME} (secret rotated)"
  else
    echo "  connection: ${CONNECTION_NAME} (exists, secret unchanged)"
  fi

  # The destination is the endpoint half. `update` rather than skip when it
  # exists, so a control plane that moved to a new origin converges here instead
  # of leaving every pause pointed at the old one.
  if exists aws events describe-api-destination \
    --name "$DESTINATION_NAME" \
    --region "$region"; then
    if [[ -n "$DRY_RUN" ]]; then
      destination_arn="arn:aws:events:${region}:${ACCOUNT_ID}:api-destination/${DESTINATION_NAME}"
    else
      destination_arn="$(aws events update-api-destination \
        --name "$DESTINATION_NAME" \
        --invocation-endpoint "$REPUTATION_ENDPOINT" \
        --http-method POST \
        --region "$region" \
        --query ApiDestinationArn --output text)"
    fi
  else
    # Only now is the connection's ARN actually needed — a destination that
    # already exists is already bound to it.
    if [[ -z "$DRY_RUN" && "${CONNECTION_EXISTS[$region_index]}" == "yes" && -z "$SUPPLIED_SECRET" ]]; then
      connection_arn="$(aws events describe-connection \
        --name "$CONNECTION_NAME" \
        --region "$region" \
        --query ConnectionArn --output text)"
    fi
    if [[ -n "$DRY_RUN" ]]; then
      destination_arn="arn:aws:events:${region}:${ACCOUNT_ID}:api-destination/${DESTINATION_NAME}"
      echo "  [dry-run] aws events create-api-destination --name ${DESTINATION_NAME} --connection-arn ${connection_arn} --invocation-endpoint ${REPUTATION_ENDPOINT} --http-method POST --region ${region}"
    else
      destination_arn="$(aws events create-api-destination \
        --name "$DESTINATION_NAME" \
        --description "Hogsend control plane, SES reputation ingress" \
        --connection-arn "$connection_arn" \
        --invocation-endpoint "$REPUTATION_ENDPOINT" \
        --http-method POST \
        --region "$region" \
        --query ApiDestinationArn --output text)"
    fi
  fi
  echo "  destination: ${REPUTATION_ENDPOINT}"

  # `put-rule` is a PUT: it creates or converges, so re-running never leaves two
  # rules double-delivering every pause.
  #
  # The pattern is the narrowing that makes the ingress's promise true. The
  # DEFAULT bus carries every AWS event in the account, and a rule matching
  # `aws.ses` alone would forward SES's send events too — thousands of
  # deliveries the ingress answers 200-and-ignores, at EventBridge's per-invoke
  # price, for no signal. Exactly the four detail-types the control plane acts
  # on, and nothing else.
  run aws events put-rule \
    --name "$RULE_NAME" \
    --event-bus-name default \
    --description "SES reputation events for the Hogsend control plane" \
    --event-pattern "{\"source\":[\"${SES_EVENT_SOURCE}\"],\"detail-type\":${SES_DETAIL_TYPES}}" \
    --state ENABLED \
    --region "$region"
  echo "  rule: ${RULE_NAME} on the default bus"

  # `put-targets` is a PUT keyed by target Id, so re-running replaces this one
  # target rather than adding a second copy of it.
  #
  # It is also the one verb in this script whose failure arrives in the BODY:
  # the CLI exits 0 and reports a FailedEntryCount instead. A freshly created
  # invoke role that has not propagated yet fails exactly this way, and
  # swallowing it would leave an ENABLED rule with NO target — the whole
  # pipeline dead while every console screen reads as subscribed. So the count
  # is read back and non-zero is fatal.
  if [[ -n "$DRY_RUN" ]]; then
    echo "  [dry-run] aws events put-targets --rule ${RULE_NAME} --event-bus-name default --targets Id=${TARGET_ID},Arn=${destination_arn},RoleArn=${INVOKE_ROLE_ARN} --region ${region}"
  else
    failed_targets="$(aws events put-targets \
      --rule "$RULE_NAME" \
      --event-bus-name default \
      --targets "Id=${TARGET_ID},Arn=${destination_arn},RoleArn=${INVOKE_ROLE_ARN}" \
      --region "$region" \
      --query FailedEntryCount --output text)"
    if [[ "$failed_targets" != "0" ]]; then
      cat >&2 <<EOF
error: put-targets reported ${failed_targets} failed entry(ies) in ${region}.

The rule exists and is ENABLED, but nothing is attached to it — every SES
event would be dropped. The usual cause is the invoke role
(${INVOKE_ROLE_NAME}) not having propagated yet; wait a minute and re-run
(every step converges). Inspect with:

  aws events list-targets-by-rule --rule ${RULE_NAME} --event-bus-name default --region ${region}
EOF
      exit 1
    fi
  fi
  echo "  target: ${RULE_NAME} -> ${DESTINATION_NAME}"
  echo

  region_index=$((region_index + 1))
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

# The secret is printed exactly once, and only on the run that MINTED it. A dry
# run installed nothing, so printing a value there would hand the operator a
# secret no connection holds; a re-run against live connections cannot read the
# stored value back and must not overwrite it.
if [[ -n "$DRY_RUN" ]]; then
  secret_line="<not shown in a dry run>"
elif [[ "$SECRET_NOTE" == "generated" ]]; then
  secret_line="$EVENTBRIDGE_SECRET"
elif [[ "$SECRET_NOTE" == "unchanged" ]]; then
  secret_line="<unchanged — keep the value already in apps/cloud/.env.local>"
else
  secret_line="<the value you passed in CLOUD_SES_EVENTBRIDGE_SECRET>"
fi

echo "CLOUD_SES_SNS_TOPIC_ARN_US=${TOPIC_ARNS[0]}"
echo "CLOUD_SES_SNS_TOPIC_ARN_EU=${TOPIC_ARNS[1]}"
echo "CLOUD_SES_EVENTBRIDGE_SECRET=${secret_line}"
echo
if [[ -z "$DRY_RUN" && "$SECRET_NOTE" == "unchanged" ]]; then
  echo "If that secret is LOST, the live connections cannot answer for it — AWS"
  echo "keeps a connection's key write-only. Delete them and re-run to mint a"
  echo "fresh one:"
  echo
  for region in "${REGIONS[@]}"; do
    echo "  aws events delete-connection --name ${CONNECTION_NAME} --region ${region}"
  done
  echo
fi
echo "The reputation ingress refuses EVERY event until that last one is set on"
echo "the deployed control plane — fail-closed, by design. Until then the rule"
echo "delivers and the endpoint answers 403."
echo
echo "Inbound (PRD 16): the relay user is now GRANTED against these names, but"
echo "neither resource is created yet — that is PRD 16 task 3's job, together"
echo "with the SES-service bucket and topic policies documented in this script."
echo
echo "  bucket: ${INBOUND_BUCKET} (prefix ${INBOUND_PREFIX})"
echo "  topic:  ${INBOUND_TOPIC_NAME} in each of ${REGIONS[*]}"
