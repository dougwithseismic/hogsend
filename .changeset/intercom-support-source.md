---
"@hogsend/engine": minor
---

Add an Intercom/Fin webhook-source preset: Intercom conversation topics become
`support.*` lifecycle events (`conversation_started`, `resolved`, `escalated`,
`rated`), verified with Intercom's `X-Hub-Signature` SHA1 scheme via the
signature-verify escape hatch and the shared constant-time compare. Identity
keys on the customer's own app user id (Intercom `external_id`) with email
co-resolution, so support activity folds onto the existing contact instead of
minting a twin; the notification id becomes the idempotency key for
at-least-once redelivery dedup. Set `INTERCOM_CLIENT_SECRET` to auto-enable at
`POST /v1/webhooks/intercom`.
