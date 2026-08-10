# PRD 03 — Send relay

**Status:** `[ ]` · **Depends:** 02 · **Boundary:** `apps/cloud`

## Goal

The control-plane endpoint a tenant instance calls to send mail. It authenticates the tenant, checks
whether they are allowed to send at all, translates neutral send options into an SES call carrying
the tenant's `TenantName` and `ConfigurationSetName`, and returns a neutral `{ id }`.

This endpoint is the reason AWS credentials never leave the control plane.

## Locked decisions

- **`POST /v1/email/send` and `POST /v1/email/send-batch`.** Two endpoints, not one polymorphic one.
  The batch shape is `BatchEmailItem[]` per the core contract and returns results positionally.
- **Auth is a per-environment relay token**, minted at provision time (PRD 06) and stored hashed.
  Presented as `Authorization: Bearer <token>`. The token identifies the environment, and the
  environment determines the SES tenant. A tenant cannot name its own SES tenant in the request
  body; if it could, tenant isolation would be advisory.
- **Idempotency is mandatory, not optional.** The engine's mailer already computes a replay-stable
  idempotency key for every send. The relay takes it as `Idempotency-Key`, and a repeat within the
  retention window returns the ORIGINAL `{ id }` without re-sending. Journeys replay on worker
  crash; without this, a redeploy mid-journey double-sends.
- **Fail closed on a paused tenant, loudly.** Locked with the user 2026-08-10. A paused environment
  gets `403` with `{ error: "tenant_paused", reason, pausedAt }`. No queueing, no BYO fallback. The
  plugin surfaces this verbatim so the journey records a real reason rather than a generic failure.
- **The allowance gate lives here** because it is the same pre-send decision point, but the counting
  and billing live in PRD 09. This PRD calls a `canSend(environmentId)` seam that PRD 09 implements;
  until then it returns `allowed` unconditionally.
- **HTML only.** The relay rejects any payload carrying React or a template reference. The engine
  renders before the wire, always.
- **Batch idempotency is PER ITEM, not per request.** A batch key alone would make a partially
  failed batch un-retryable: retrying returns the original response and the failed items never send.
  Each item carries its own key; the engine's mailer already computes one per message.
- **The relay is rate limited per environment**, independently of the monthly allowance. The
  allowance is a monthly ceiling and does nothing to stop a leaked token emptying it in ninety
  seconds. A burst limit is the only control that operates on the timescale an incident does.

## Acceptance criteria (EARS)

- WHEN a request arrives without a valid relay token, the system SHALL return `401` and SHALL NOT
  call SES.
- WHEN a valid token identifies an environment whose sending status is paused, the system SHALL
  return `403` with `error: "tenant_paused"`, the recorded reason, and the pause timestamp, and
  SHALL NOT call SES.
- WHEN a request carries an `Idempotency-Key` that has been seen for the same environment within the
  retention window, the system SHALL return the stored `{ id }` with `200` and SHALL NOT call SES a
  second time.
- WHEN a valid send request is accepted, the system SHALL call `sendEmail` with the environment's
  `TenantName` and `ConfigurationSetName` both present, and SHALL return the SES message id as a
  neutral `{ id }`.
- WHEN SES returns a `tenant_paused` or `account_paused` error, the system SHALL persist the paused
  state for that environment before returning, so the next request short-circuits without a network
  call.
- WHEN SES returns a transient error, the system SHALL return `503` and SHALL NOT record an
  idempotency entry, so the caller's retry can succeed.
- WHEN a batch request is submitted, the system SHALL return one result per input item in input
  order, with per-item success or error, and a partial failure SHALL NOT fail the whole batch.
- WHEN a batch is retried after a partial failure, the system SHALL short-circuit the items whose
  per-item idempotency keys already succeeded and SHALL re-attempt only the failed ones.
- WHEN an environment exceeds its burst rate limit, the system SHALL return `429` with a
  `Retry-After` header, SHALL NOT call SES, and SHALL NOT consume allowance.

## Tasks

1. **Relay token model and verification.** A `relay_tokens` table (or a `provider_keys` row with
   provider `hogsend-email`, decided during build) storing a hash, never the plaintext. A
   constant-time verify that resolves token → environment. Reuse the existing AES-256-GCM helper
   under `CLOUD_ENCRYPTION_SECRET`; do not introduce a second secret mechanism.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **Idempotency store.** Keyed `(environment_id, idempotency_key)`, storing the returned message id
   and a created-at, with a documented retention window and a sweep. Unique index is the concurrency
   guard, so two simultaneous identical sends cannot both reach SES.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **Sending-status store and the fail-closed check.** Per-environment `sending_status`
   (`active | paused | enforced | reinstated`), reason, and timestamp. PRD 08 writes it from
   EventBridge; this PRD reads it and creates the table.
   _Boundary:_ `apps/cloud` · _Depends:_ none

4. **`POST /v1/email/send`.** Zod request/response schemas registered in `apps/cloud/src/openapi.ts`
   like every other cloud route. Auth → paused check → allowance seam → idempotency → `sendEmail`.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2, 3

5. **`POST /v1/email/send-batch`**, positional results, partial failure tolerated, per-item
   idempotency.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

6. **Per-environment burst rate limit**, returning `429` with `Retry-After` and consuming no
   allowance. Reuse the existing cloud rate-limit mechanism if one is present; check before building.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

7. **Tests against the Fake `SesClient`.** Every EARS line above gets a test. Specifically prove:
   double-send with the same idempotency key calls the Fake exactly once (assert the call counter,
   not the response); a partially failed batch retry re-attempts only the failed items; a paused
   environment never reaches the Fake; a transient error leaves no idempotency row behind; a
   rate-limited request consumes no allowance. Mutation-check the idempotency guard and the
   fail-closed paused check.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 4, 5, 6

## Seams

- **`canSend(environmentId)`** is a stub returning `allowed` until PRD 09 implements it. Define the
  interface here so PRD 09 is a drop-in.

## Done when

Both endpoints exist with OpenAPI schemas, all EARS criteria have passing tests against the Fake,
the idempotency guard is mutation-checked, and gates are green.

## Implementation Notes
</content>
