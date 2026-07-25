# PRD 09 — `withDurableGate`: make the positional-journal law unwritable-wrong

**Depends on:** PRD 03 · **Status:** `[ ]` · **Priority: P0**

## Goal

Stop the fifth positional-journal bug from being written. Extract the one correct shape into a single
primitive so authors cannot get the ordering wrong, because the ordering is no longer theirs to write.

## Why

Four bugs of this class in one release, by three different authors:

1. Gate chain early-returned `cached` before `memoize` (caught in plan review, pre-code).
2. The memo key derived from `refined_company_domain` — a value the function itself writes.
3. `resolveTarget`'s live `contacts` read sat outside the closure, so both the *decision to issue*
   `memoize` and the key derived from mutable state (reproduced: double vendor spend).
4. The `no_lookup_key` path issued zero durable calls, and a test asserted that as correct.

The law is stated plainly at `packages/engine/src/lib/feed.ts:152-165`. It is **prose enforced by
nothing**. Every durable helper — `sendEmail`, `sendSms`, `sendConnectorAction`, `refineContact` —
re-derives the shape by hand, and a mistake is invisible: every gate reports green.

## Locked decisions

- **Extract, do not rewrite.** `refineContact` is now correct and proven (replay drill passed against
  a real killed worker, including the mutation variant). The primitive must be a faithful extraction
  of its current shape, not an improvement on it. Behaviour must be identical.
- **Port `refineContact` ONLY in this PRD.** Porting `sendEmail`/`sendSms`/`sendConnectorAction` is a
  follow-up — each has its own subtleties and its own test surface, and doing all four at once turns
  a safe refactor into a risky one.
- The primitive lives in `packages/engine/src/journeys/`, beside `journey-boundary.ts`.
- `callerRef` must be **typed** so a DB-derived value cannot be passed. A type error at the call site
  beats a code-review catch. If the type system cannot express it cleanly, a documented branded type
  is acceptable; a comment is not.

## Shape

```ts
withDurableGate<T>(
  opts: {
    kind: JourneyKeyKind;
    callerRef: CallerRef;          // derived ONLY from the caller's own arguments
    idempotencyLabel?: string;
  },
  gates: () => Promise<T>,         // EVERY stateful read and side effect lives in here
): Promise<T>
```

Owns, in this order and unconditionally: resolve boundary → if none, run `gates()` directly →
else derive key from `callerRef` → `registerKey` → `boundary.memoize([key], gates)`.

## Acceptance criteria (EARS)

1. WHEN a journey boundary exists the primitive SHALL issue exactly ONE `memoize` call per invocation
   regardless of which path `gates()` returns from, including an early return inside `gates()`.
2. WHEN no boundary exists the primitive SHALL run `gates()` directly and issue zero durable calls.
3. WHEN the same `callerRef` and `idempotencyLabel` are supplied the derived key SHALL be identical
   across invocations; when either differs the key SHALL differ.
4. WHEN a caller attempts to pass a value not derived from its own arguments as `callerRef` the code
   SHALL fail to type-check.
5. WHEN `refineContact` is ported to the primitive its externally observable behaviour SHALL be
   unchanged — all 18 `refine-contact` vitest tests and all `refine-chain` node:tests pass untouched.
6. WHEN `gates()` throws the primitive SHALL propagate the error without swallowing it, and SHALL NOT
   leave a partially-recorded memo.

## Tasks

### T9.1 — The primitive + its own tests
_Boundary:_ `packages/engine/src/journeys` · _Depends:_ —

New file, node:test colocated. AC 1–4 and 6 provable with a recording stub boundary — no DB.

### T9.2 — A shared law-test helper
_Boundary:_ `packages/engine` · _Depends:_ T9.1

Extract the technique from `refine-chain.test.ts`'s AC 11 test into a reusable helper: drive any
durable function through N different return paths and assert the durable-call journal is
byte-identical. That test is the ONLY reason defect 4 was catchable; every future durable helper
should get it for free.

### T9.3 — Port `refineContact`
_Boundary:_ `packages/engine/src/lib` · _Depends:_ T9.1

Replace the hand-rolled block in `refine-chain.ts`. **Do not change behaviour.** The existing tests
are the regression net — if any needs editing, that is a signal the extraction is wrong, not that the
test is wrong.

## Done when

Six criteria pass, `refineContact`'s existing suites are green **unmodified**, and the mutation from
the D1 fix still fails (restore the old shape → tests fail).

## Implementation Notes

_(filled in during build)_
