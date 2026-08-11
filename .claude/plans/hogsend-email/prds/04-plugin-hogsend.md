# PRD 04 — packages/plugin-hogsend

**Status:** `[ ]` · **Depends:** 03 · **Boundary:** `packages/plugin-hogsend`

## Goal

The `EmailProvider` itself: the dumb wire that turns an engine send into a relay call. Modelled on
`packages/plugin-postmark`, which is the most recent reference implementation and already solves the
opt-in-package problem.

The engine keeps everything that matters. This package renders nothing, tracks nothing, checks no
preferences, and writes no `email_sends` row. If a reviewer finds any of that in here, it is a bug.

## Locked decisions

- **Authored with `defineEmailProvider()`.** `meta: { id: "hogsend", name: "Hogsend Email" }`.
- **Capabilities per DECISIONS §3.6:** `nativeTracking: false`, `scheduledSend: false`,
  `signedWebhooks: true`. `scheduledAt` is logged and dropped with a message pointing at
  `ctx.sleepUntil`, matching how Postmark handles an unsupported capability.
- **Config is `{ relayUrl, tenantToken, webhookSecret? }`.** No AWS anything. No Cloud-shaped
  assertion on the token. DECISIONS §1: Cloud-only by policy, not by a hard check.
- **An OPT-IN package**, exactly like `plugin-postmark`: an engine `optionalDependency`, loaded via
  the guarded dynamic import with a runtime-assembled specifier. A static import would make it
  mandatory for every self-hosted consumer and would fail `tsc` with TS2307 in a fresh scaffold.
  PRD 10 does the wiring; this PRD just must not make itself mandatory.
- **`verifyWebhook` fails closed.** No secret configured means every webhook is rejected. Postmark
  set this precedent and it is the right one.
- **`verifyWebhook` also bounds the replay window** (added 2026-08-10, during PRD 05, after that
  PRD's author found the gap rather than working around it). The signature alone leaves replay
  unbounded: a captured valid payload stays valid forever. The timestamp is already inside the HMAC'd
  body as `occurredAt`, so it is bound and unforgeable, and the check is simply to read it — no
  extra header, since an unverified header the plugin ignores is signature theatre that reads as
  "done" to the next auditor.

  Order is signature → parse → timestamp; never read a timestamp out of a payload whose signature is
  unchecked. Bounded both ways: stale rejected, far-future rejected (guarding our own clock bugs
  rather than an attacker, who cannot forge one). **The skew defaults to hours, not minutes**, and
  that is deliberate: SES `DeliveryDelay` events legitimately arrive long after `occurredAt`, and
  they must survive SNS's retries plus the control plane's before reaching the instance. A dropped
  bounce is worse than a replayed one, because a replay re-delivers an event the engine already
  dedupes while a drop means suppression never happens at all.
- **Errors from the relay pass through with their shape intact.** A `403 tenant_paused` becomes a
  typed error the mailer can record, not a generic send failure. The whole point of the fail-loud
  decision is that the reason survives to the journey.
- **No `domains` member in this PRD.** PRD 07 adds it. Presence is the gate, so shipping without it
  degrades gracefully and correctly.
- **This PRD OWNS the relay webhook payload shape**, exported as a type from
  `packages/plugin-hogsend`. PRD 05 imports it and produces it. Defining it in 05 instead would make
  04 and 05 mutually dependent, which is a cycle the build order cannot satisfy. The consumer of a
  contract is the wrong place to define it only when the producer is upstream; here the producer
  (the control plane) is downstream of the wire, so the wire owns the shape.

## Acceptance criteria (EARS)

- WHEN `send` is called, the system SHALL POST HTML-only options to `<relayUrl>/api/email/send` with
  the tenant token as a bearer credential, and SHALL return the relay's `{ id }` unchanged.
- WHEN the caller supplies an idempotency key, the system SHALL forward it as the `Idempotency-Key`
  header. The relay REQUIRES it and answers `400 missing_idempotency_key` without one, so the
  provider must always send one rather than treating it as optional.
- WHEN `sendBatch` is called, the system SHALL POST to `/api/email/send-batch` and SHALL return one
  result per input item in input order.

**Paths corrected 2026-08-10.** These read `/v1/email/…` in the original draft. `apps/cloud` is a
Next App Router app with no `/v1` prefix anywhere; PRD 03 shipped the routes at `/api/email/send`
and `/api/email/send-batch`. The relay is the built thing, so it is the authority.
- WHEN the relay returns `403 tenant_paused`, the system SHALL throw a typed error carrying the
  reason and pause timestamp, and SHALL NOT retry.
- WHEN `scheduledAt` is supplied, the system SHALL log once that scheduled send is unsupported,
  SHALL point at `ctx.sleepUntil`, and SHALL send immediately rather than failing.
- WHEN `verifyWebhook` runs with no configured secret, the system SHALL throw and SHALL NOT parse
  the payload.
- WHEN `verifyWebhook` runs with a valid signature, the system SHALL return a normalized `EmailEvent`
  whose `type` is one of the existing `EmailEventType` values, with `messageId`, `recipients`,
  `occurredAt`, and `raw` populated, and `bounce` classified into the existing neutral union.
- WHEN the package is absent from a consumer's `node_modules`, the engine SHALL still type-check and
  boot.

## Tasks

1. **Scaffold `packages/plugin-hogsend`** — `package.json`, tsup config, tsconfig extending
   `@repo/typescript-config`, mirroring `plugin-postmark` exactly. Add to the workspace. If it takes
   any runtime dependency, mirror it into the `create-hogsend` template `_package.json` per
   DECISIONS §5.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ none

2. **`createHogsendEmailProvider(cfg)`** — `defineEmailProvider` with meta and capabilities, and the
   `send`/`sendBatch` wires over `fetch`. Typed relay errors, no retry on 4xx.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 1

3. **Define and export the relay webhook payload shape** (`HogsendRelayEmailEvent`), plus its Zod
   schema. This is the contract PRD 05 produces against.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 1

4. **`verifyWebhook` / `parseWebhook`** — HMAC verification against `webhookSecret`, fail closed when
   unset, normalize the relay shape into the core `EmailEvent` union; classify bounces into
   `permanent | transient | complaint | unknown`, defaulting to `unknown`.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ tasks 2, 3

5. **Tests.** Mirror `plugin-postmark/src/__tests__/provider.test.ts`. Cover every EARS line. Prove
   HTML-only by asserting no React ever reaches the wire, prove fail-closed webhook auth by
   mutation-check, and assert a `403 tenant_paused` produces a typed error with the reason intact.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ tasks 2, 3, 4

## Seams

None. This PRD ships complete against a stubbed relay. It owns the webhook shape rather than
importing it, so nothing here waits on a downstream PRD.

## Done when

The provider satisfies the `EmailProvider` contract, all EARS criteria are tested, the package is
opt-in and does not break a consumer that lacks it, and gates are green.

## Implementation Notes
</content>
