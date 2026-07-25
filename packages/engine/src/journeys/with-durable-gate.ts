import {
  deriveJourneyKey,
  getJourneyBoundary,
  type JourneyKeyKind,
  registerKey,
} from "./journey-boundary.js";

// ---------------------------------------------------------------------------
// CallerRef — the branded discriminant
// ---------------------------------------------------------------------------

/**
 * The brand is a module-private `unique symbol`: no other module can name it,
 * so no other module can construct a {@link CallerRef} structurally. The ONLY
 * two ways to produce one are {@link callerRefFromArgs} and a deliberate
 * `as CallerRef` cast — the first is the sanctioned chokepoint, the second is
 * greppable and indefensible in review. That is the point: provenance ("this
 * string came from the caller's own arguments, not from an awaited DB read")
 * is not something TypeScript can track through data flow, so the design
 * substitutes a single, named, reviewable construction site for it.
 */
declare const CALLER_REF: unique symbol;

/**
 * A string proven — by construction — to be derived from the CALLER'S OWN
 * ARGUMENTS, and therefore legal as a durable-memo key discriminant.
 *
 * THE LAW (`lib/feed.ts:152-165`): the Hatchet journal is positional, and
 * `boundary.memoize` is a durable call, so its KEY must never contain the
 * result of a live DB read. Hatchet re-derives task input from the recorded
 * payload, so an ARGUMENT is identical on a run and its replay — a resolved
 * row value is not (defects 2 and 3 of this class both keyed a memo off a
 * value the database could change mid-sleep).
 *
 * A bare `string` — including every string that arrives via `await` — fails to
 * type-check where a `CallerRef` is required. Route it through
 * {@link callerRefFromArgs} ONLY when the value is an authored argument.
 */
export type CallerRef = string & { readonly [CALLER_REF]: true };

/**
 * Brand a value from the caller's own arguments as a {@link CallerRef}.
 *
 * CONTRACT (the compiler cannot check this half — the call site carries it):
 * `value` must be derived exclusively from the caller's authored arguments.
 * Never pass a value produced by an awaited read (a `contacts` row, a ledger
 * row, a provider response) — that is precisely the bug class this type
 * exists to make unwritable.
 *
 * Trims, and returns `undefined` for an empty/whitespace value so callers can
 * fall through their argument-precedence chain with `??`/`if`.
 */
export function callerRefFromArgs(
  value: string | undefined,
): CallerRef | undefined {
  const trimmed = value?.trim();
  return trimmed ? (trimmed as CallerRef) : undefined;
}

// ---------------------------------------------------------------------------
// withDurableGate — the one correct shape, owned once
// ---------------------------------------------------------------------------

export interface WithDurableGateOptions {
  /** The side-effect namespace — keeps e.g. a refine and a send from ever
   * colliding under one wait label. */
  kind: JourneyKeyKind;
  /**
   * The memo-key discriminant, derived ONLY from the caller's own arguments —
   * the branded type makes a raw (possibly DB-read) string a type error at the
   * call site. See {@link CallerRef}.
   */
  callerRef: CallerRef;
  /**
   * Disambiguates the key when two sites of the same `kind` in one journey
   * share a nearest wait label. Mirrors `sendEmail`/`sendSms`/`refineContact`.
   */
  idempotencyLabel?: string;
}

/**
 * Run `gates` under the positional-journal law, so the law is structural
 * rather than prose.
 *
 * Four bugs of one class shipped in one release, by three different authors,
 * every one green on every gate: an early return placed before the memoize, a
 * memo key derived from a value the function itself writes, a live read
 * feeding both the decision to memoize and the key, and a skip path that
 * issued zero durable calls. Each author re-derived this shape by hand and
 * got one line of it wrong. This primitive owns the shape, so the ordering is
 * no longer the author's to write.
 *
 * What it does, in this order and UNCONDITIONALLY:
 *
 *  1. Resolve the journey boundary. With NO boundary (a webhook, a cron, a
 *     test) there is no replay to defend against and no anchor to key from —
 *     `gates()` runs directly, zero durable calls, and Layer 2 (the callee's
 *     unique-index dedup) carries exactly-once on its own.
 *  2. With a boundary: derive the key from `kind` + the replay-stable
 *     `runAnchor` + the site (`idempotencyLabel ?? nearest wait label ??
 *     callerRef`) + the branded `callerRef` — arguments only, never a
 *     resolved value.
 *  3. `registerKey` — an intra-run collision (two sites, one key) throws
 *     loudly at dev time instead of silently over-deduping.
 *  4. Issue `boundary.memoize([key], …)` — EXACTLY ONCE, with nothing between
 *     the boundary check and this call that reads a database or branches on
 *     one. Every stateful read and every verdict — including every skip —
 *     lives INSIDE `gates`, so it is recorded by the durable memo and
 *     replayed verbatim.
 *
 * `gates` receives the derived key (undefined outside a boundary) to thread
 * into its Layer-2 writes as the idempotency key. A throw from `gates`
 * propagates unswallowed; the memo layer records no value for a rejected
 * closure, so a replay re-enters it.
 */
export async function withDurableGate<T>(
  opts: WithDurableGateOptions,
  gates: (idempotencyKey?: string) => Promise<T>,
): Promise<T> {
  // `async` is part of the contract: a `registerKey` collision surfaces as a
  // REJECTION, exactly as it did when this block lived inside the (async)
  // `runRefineChain` — never as a synchronous throw at the call expression.
  const boundary = getJourneyBoundary();

  // Outside a journey run there is no replay to defend against and no boundary
  // to key from — run the gates directly (connector-actions.ts:342).
  if (!boundary) return gates();

  // UNCONDITIONAL from here: derive → register → memoize. Nothing between this
  // comment and the `memoize` call may read the database or branch on one.
  const site = opts.idempotencyLabel ?? boundary.currentLabel ?? opts.callerRef;
  const key = deriveJourneyKey({
    kind: opts.kind,
    anchor: boundary.runAnchor,
    site,
    discriminant: opts.callerRef,
  });
  registerKey(boundary, key);

  return boundary.memoize([key], () => gates(key));
}
