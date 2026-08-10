# PRD 03 — Send relay

**Status:** `[ ]` · **Depends:** 02 · **Boundary:** `apps/cloud`

## Goal

The control-plane endpoint a tenant instance calls to send mail. It authenticates the tenant, checks
whether they are allowed to send at all, translates neutral send options into an SES call carrying
the tenant's `TenantName` and `ConfigurationSetName`, and returns a neutral `{ id }`.

This endpoint is the reason AWS credentials never leave the control plane.

## Locked decisions

- **`POST /api/email/send` and `POST /api/email/send-batch`.** Two endpoints, not one polymorphic
  one. The batch shape is `BatchEmailItem[]` per the core contract and returns results positionally.

  **Corrected 2026-08-10 against the real app.** This PRD originally said `/v1/email/…` with "Zod
  schemas registered in `apps/cloud/src/openapi.ts` like every other cloud route". Both were wrong:
  `apps/cloud` is a **Next.js App Router** app, not Hono, so routes are `route.ts` handlers under
  `apps/cloud/app/api/…` and there is no `/v1` prefix anywhere in it. And `openapi.ts` states its
  own policy explicitly: it documents the UNAUTHENTICATED surface, and the token-authenticated
  machine routes (`/api/cli/*`, `/api/publish/*`, `/api/builds/*`) are deliberately excluded because
  they are consumed only by our own software. The relay is exactly that kind of route, so it follows
  the same rule and is **not** added to `openapi.ts`. Do not invent a Hono router for it.

  Files: `apps/cloud/app/api/email/send/route.ts` and `apps/cloud/app/api/email/send-batch/route.ts`.
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

1. **Relay token model and verification.** A dedicated `relay_tokens` table storing a **hash**,
   never the plaintext, with the hash column uniquely indexed so verification is one indexed lookup.

   **Decided here rather than during build:** it must NOT be a `provider_keys` row.
   `provider_keys` stores reversible AES-256-GCM ciphertext keyed by `(environment_id, provider)`,
   which answers "what is this environment's credential" and cannot answer "which environment does
   this bearer token belong to" without decrypting every row in the table on every request. Those
   are different questions and they need different storage. Hash the presented token and look the
   hash up directly.

   Use a fast keyed hash (HMAC-SHA-256 under `CLOUD_ENCRYPTION_SECRET`), not a password KDF: the
   token is a 32-byte random secret, not a human password, so there is nothing to brute-force and a
   per-request bcrypt would price the relay out. Compare with `crypto.timingSafeEqual` on
   equal-length buffers. Do not introduce a second secret mechanism.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **Idempotency store.** Keyed `(environment_id, idempotency_key)`, storing the returned message id
   and a created-at, with a documented retention window and a sweep. Unique index is the concurrency
   guard, so two simultaneous identical sends cannot both reach SES.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **Sending-status store and the fail-closed check.** Per-environment `sending_status`
   (`active | paused | enforced | reinstated`), reason, and timestamp. PRD 08 writes it from
   EventBridge; this PRD reads it and creates the table.
   _Boundary:_ `apps/cloud` · _Depends:_ none

4. **`POST /api/email/send`** as a Next App Router handler at
   `apps/cloud/app/api/email/send/route.ts`. Zod-validated request body, JSON response. Order of
   operations is load-bearing: auth → paused check → rate limit → allowance seam → idempotency →
   `sendEmail`. Rate limit precedes allowance so a throttled request consumes nothing.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2, 3

5. **`POST /api/email/send-batch`**, positional results, partial failure tolerated, per-item
   idempotency.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

6. **Per-environment burst rate limit**, returning `429` with `Retry-After` and consuming no
   allowance. **Reuse `apps/cloud/src/lib/rate-limit.ts`** (`consumeRateLimit` /
   `consumeDualRateLimit`, already used by the CLI and auth routes); do not build a second limiter.
   Key on the environment id from the verified token, NOT on client IP: the caller is a tenant
   instance, so IP is neither stable nor the thing being limited.
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

Both endpoints exist as Next route handlers, all EARS criteria have passing tests against the Fake,
the idempotency guard is mutation-checked, and gates are green.

## Implementation Notes

Shipped 2026-08-10 as `423042e8`. Cloud suite 1118 → 1164 tests.

**The wire, for PRDs 04 and 10.** `POST /api/email/send` takes `{ message }` with a **required**
`Idempotency-Key` header and answers `{ id }`. `POST /api/email/send-batch` takes
`{ items: [{ idempotencyKey, message }] }` and answers `{ results }`, positional. Error bodies are
`{ error: <slug>, message, ... }`; `403 tenant_paused` additionally carries `reason` and `pausedAt`,
verbatim, so a journey records a real sentence rather than a generic failure.

**Order of operations is load-bearing** and is documented at the top of `lib/email-relay.ts`:
auth → paused → rate limit → validate → allowance → idempotency → send. Each step precedes one that
is expensive or irreversible.

**Three controls added during build that the spec did not ask for, kept because each closes a real
hole:**

1. **A batch charges its true item count** against the burst limit (one unit before the body is
   read, the remaining `items.length - 1` once the count is known). Charging one per request would
   make batching a way to buy fifty times the budget, which is exactly what a leaked token would do.
2. **The request body is metered as it streams**, not merely checked against `Content-Length`, which
   is a hint a caller writes. Without it, any holder of a valid token could make the process buffer
   unbounded memory, and the burst limiter would not stop it: a REFUSED request never allocates, but
   six hundred ALLOWED ones a minute do.
3. **Strict schemas** on both bodies, so an attempt to supply `tenantName` is a 400 rather than a
   silently ignored field somebody later "helpfully" reads. Tenant isolation should not depend on a
   field being forgotten.

**The at-least-once window, stated so it is never rediscovered as a surprise.** The idempotency
guard is INSERT … ON CONFLICT DO NOTHING, then a compare-and-set takeover of any claim older than
60s. A process that dies AFTER SES accepted the message but BEFORE the commit lands leaves a claim
indistinguishable from one that died before the send, so the takeover re-sends and the recipient
gets it twice. **This cannot be fixed** — SES is not in our transaction — and it is only a choice of
which way to be wrong. A duplicate lifecycle email is recoverable; a password reset that never
arrives is not. The default is deliberately "send again".

The complementary invariant is absolute and load-bearing: **a row carrying a message id means the
message reached SES.** Every failure path releases the claim, because a key left behind by a failed
send would make the caller's retry return success for a message nobody received, which is silent,
permanent loss.

**Deliberately still open for PRD 09:** `canSend()` returns allowed unconditionally via
`lib/email-allowance.ts`. The refusal path (402, with limit/used/resetsAt) is already written and
tested, so PRD 09 supplies the gate and changes nothing else.
</content>
