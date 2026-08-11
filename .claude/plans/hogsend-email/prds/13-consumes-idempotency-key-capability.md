# PRD 13 — Declare `consumesIdempotencyKey` as a real capability

**Status:** `[ ]` · **Depends:** 10 · **Boundary:** `packages/core`, `packages/engine`, `packages/plugin-hogsend`

## Goal

Retire the `provider.meta?.id === "hogsend"` hardcode in
`packages/engine/src/lib/tracked.ts:providerConsumesIdempotencyKey`.

The gate itself is correct and load-bearing: it is what stops the engine stamping internal
idempotency keys, which embed Hatchet run ids, wait labels and (for campaign sends) the recipient's
own email address, onto outbound mail through providers that forward `headers` verbatim. That is the
single worst defect this wave caught. Nothing here weakens it.

What is wrong is only HOW a provider says yes. Today there are two ways: a cast-through-`unknown`
read of an undeclared `consumesIdempotencyKey` field, or being named `hogsend`. The first is
invisible to the type system, so a third-party provider author has no way to discover it. The second
means a first-party package gets a behaviour no one else can opt into by writing correct code.

## Locked decisions

- **Declare the flag on `EmailProviderCapabilities` in `@hogsend/core`.** That interface is the
  documented place a provider states what its transport does, and the other three flags
  (`nativeTracking`, `scheduledSend`, `signedWebhooks`) set the precedent.
- **`plugin-hogsend` declares it explicitly.** The id check exists because the package did not
  declare the flag; the fix is for it to declare the flag.
- **Default is `false` / absent, and that default is the safe one.** A provider that says nothing
  gets today's behaviour: no key threaded, no header on the message. Absence must never be read as
  consent, because the failure mode is silent and lands on real recipients.
- **The id hardcode is DELETED, not left as a fallback.** Kept "just in case" it would mask a
  regression where `plugin-hogsend` stops declaring the flag, which is exactly the regression the
  declaration exists to make visible.
- **Drop the `as` cast.** Once the field is declared the cast is not just unnecessary, it is
  actively harmful: it would keep compiling if the field were renamed or removed.
- **This is not a breaking change and must not become one.** No existing provider declares the flag,
  so every existing deploy's wire behaviour is byte-for-byte identical. Assert that rather than
  assuming it.

## Acceptance criteria (EARS)

- WHEN a provider declares `capabilities.consumesIdempotencyKey: true`, the system SHALL thread the
  replay-stable key to its transport as the `Idempotency-Key` header.
- WHEN a provider omits the flag or declares it `false`, the system SHALL NOT thread the key, and the
  delivered message's headers SHALL be identical to what they were before this PRD.
- WHEN a provider declares the flag `true` but is not `hogsend`, the system SHALL thread the key —
  proving the behaviour is reachable by a third party through declaration alone.
- WHEN `plugin-hogsend` is constructed, its `capabilities` SHALL declare
  `consumesIdempotencyKey: true`.
- WHEN a provider named `hogsend` does NOT declare the flag, the system SHALL NOT thread the key,
  proving the id hardcode is gone rather than merely shadowed.
- WHEN a caller places an `Idempotency-Key` in `options.headers` themselves, the system SHALL pass it
  through untouched regardless of provider capability, exactly as today.

## Tasks

1. **Declare `consumesIdempotencyKey?: boolean` on `EmailProviderCapabilities`** with a doc comment
   that states the danger plainly: providers forwarding `headers` verbatim must NOT set it, and the
   consequence of setting it wrongly is internal keys delivered on customer mail.
   _Boundary:_ `packages/core` · _Depends:_ none

2. **Declare the flag in `plugin-hogsend`'s `capabilities`.**
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 1

3. **Simplify `providerConsumesIdempotencyKey`** to a plain read of the declared flag. Delete the
   cast and the id check. Rewrite the doc comment so it explains the rule rather than the history.
   _Boundary:_ `packages/engine` · _Depends:_ tasks 1, 2

4. **Tests.** Every EARS line, including the two negative ones that are the actual point: a
   `hogsend`-named provider that does not declare the flag gets no key, and a non-hogsend provider
   that does declare it gets one. Mutation-check the default: flip the fallback to `true` and confirm
   the Resend/Postmark no-header tests go red.
   _Boundary:_ `packages/engine` · _Depends:_ task 3

## Seams

None.

## Done when

The flag is declared in core, `plugin-hogsend` declares it, the engine reads only the declaration,
the id hardcode is gone, a third-party provider can opt in by declaration alone with a test proving
it, and gates are green.

## Implementation Notes
