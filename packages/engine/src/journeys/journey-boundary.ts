import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The minimal slice of Hatchet's `DurableContext` the boundary needs for its
 * Layer-1 fast path. The real context structurally satisfies this; tests pass a
 * stub. `memo(fn, deps)` is TS-`private` on the SDK class (1.22.3,
 * context.d.ts:457) so it can only be reached via an `as any` cast at the call
 * site — we model it here as optional so a probe (`typeof … === "function"`)
 * gates it. `supportsEviction` (engineVersion >= v0.80.0) is the public getter
 * that decides whether `memo` is actually durable: when false, the SDK's `memo`
 * returns a bare `fn()` with ZERO durability, so we must NOT rely on it.
 */
export interface HatchetMemoCtx {
  memo?: <T>(fn: () => Promise<T> | T, deps: unknown[]) => Promise<T>;
  supportsEviction?: boolean;
}

/**
 * Per-enrollment, per-run state threaded through `AsyncLocalStorage` so the
 * standalone `sendEmail` / `ctx.trigger` side-effect helpers can be made
 * EXACTLY-ONCE across a durable replay WITHOUT any change to journey-authoring
 * signatures. The boundary is established once in `define-journey` around the
 * `run()` call; a replay-from-top re-enters that scope from the top, so the
 * boundary is re-derived deterministically each time.
 */
export interface JourneyBoundary {
  /** The `journeyStates.id` — used for FK/observability and as the key anchor
   * fallback when no replay-stable run id is available (tests, outside a durable
   * run). NOT the primary key anchor — see {@link runAnchor}. */
  stateId: string;
  /**
   * The replay-stable per-enrollment anchor every derived key uses: the Hatchet
   * `workflowRunId()`. Unlike `stateId` (a fresh `defaultRandom()` uuid that can
   * differ if a replay-from-top mints a new `journey_states` row for a terminal
   * prior enrollment), the run id is preserved across replays of the SAME logical
   * durable run — so both dedup layers' keys collide as intended on a replay.
   * Falls back to `stateId` when absent (a non-durable test/harness context).
   */
  runAnchor: string;
  /**
   * The nearest authored wait/checkpoint label, captured as side effects run so
   * a same-template send inherits the label of the `ctx.sleep`/`waitForEvent`/
   * `checkpoint` that immediately preceded it. This is the "site" discriminant
   * that lets two sends of the SAME template on different branches derive
   * distinct keys for free, without an explicit authoring label.
   */
  currentLabel: string | undefined;
  /**
   * Every derived key seen so far in THIS run. A second side effect that derives
   * an already-seen key would silently over-dedup (the second email/trigger
   * would be suppressed), so {@link registerKey} throws loudly instead — the
   * footgun is a fail-fast dev error, never a silently-dropped message.
   */
  seenKeys: Set<string>;
  /**
   * Layer-1 fast path: run `fn` through Hatchet's durable `memo` keyed by
   * `deps` when (and only when) the engine supports eviction; otherwise fall
   * through to a bare `fn()`. Belt-and-suspenders over the Layer-2 DB key — when
   * eviction is live the provider/ingest call is skipped before the DB is even
   * touched; when it isn't, Layer 2 still guarantees exactly-once.
   */
  memoize<T>(deps: unknown[], fn: () => Promise<T> | T): Promise<T>;
}

const journeyBoundaryAls = new AsyncLocalStorage<JourneyBoundary>();

/**
 * The active journey boundary, or `undefined` when not inside a journey `run()`
 * (e.g. an admin bulk send or a `POST /v1/emails` call). Standalone helpers read
 * this to decide whether to auto-key + memoize their side effect.
 */
export function getJourneyBoundary(): JourneyBoundary | undefined {
  return journeyBoundaryAls.getStore();
}

/** Run `fn` with `boundary` installed as the active journey boundary. */
export function runWithJourneyBoundary<T>(
  boundary: JourneyBoundary,
  fn: () => Promise<T>,
): Promise<T> {
  return journeyBoundaryAls.run(boundary, fn);
}

/**
 * Build the {@link JourneyBoundary.memoize} closure for a given Hatchet context.
 * Probes `memo`/`supportsEviction` at call time (not construction time) so a
 * degraded engine cleanly falls through to `fn()`. Accepts `unknown` and casts
 * to {@link HatchetMemoCtx} internally: the SDK's `memo` is TS-`private`, so the
 * real `DurableContext` is not assignable to a public-`memo` type — keeping the
 * cast HERE contains the one brittle SDK-private access to this single helper.
 */
export function createMemoize(hatchetCtx: unknown): JourneyBoundary["memoize"] {
  const ctx = hatchetCtx as HatchetMemoCtx;
  return async <T>(deps: unknown[], fn: () => Promise<T> | T): Promise<T> => {
    const memo = ctx.memo;
    if (typeof memo === "function" && ctx.supportsEviction === true) {
      return memo(fn, deps);
    }
    return fn();
  };
}

/**
 * Read `supportsEviction` off a Hatchet context for boot-time logging, tolerating
 * the same private-member assignability gap as {@link createMemoize}.
 */
export function supportsEviction(hatchetCtx: unknown): boolean {
  return (hatchetCtx as HatchetMemoCtx).supportsEviction === true;
}

/** The kind of side effect a key is derived for — keeps the namespaces apart. */
export type JourneyKeyKind = "send" | "trigger" | "connector";

const KEY_PREFIX: Record<JourneyKeyKind, string> = {
  send: "journeySend",
  trigger: "journeyTrigger",
  connector: "journeyConnector",
};

/**
 * Derive the deterministic, branch-stable idempotency key shared by BOTH defense
 * layers. Content/site-derived (NEVER a positional counter), so a replay that
 * reaches a given logical side effect re-derives the SAME key and a genuinely
 * different side effect derives a DIFFERENT key — in both branch directions.
 *
 *   send      → `journeySend:<anchor>:<site>:<discriminant>`
 *   trigger   → `journeyTrigger:<anchor>:<site>:<discriminant>`
 *   connector → `journeyConnector:<anchor>:<site>:<discriminant>`
 *
 * `anchor` is the REPLAY-STABLE per-enrollment id (`boundary.runAnchor`, the
 * Hatchet `workflowRunId()`), NOT the freshly-minted `journeyStates.id`: a
 * replay-from-top that mints a new state row for a terminal prior enrollment
 * would otherwise derive a NON-colliding key and re-deliver. `site` is the
 * explicit `idempotencyLabel` ?? the nearest authored wait label ?? the
 * discriminant itself (templateKey for sends, event name for triggers). The key
 * contains NO wall-clock and NO live-DB-read result, so it is stable across the
 * clock/branch divergence a replay can introduce.
 */
export function deriveJourneyKey(opts: {
  kind: JourneyKeyKind;
  /** The replay-stable per-enrollment anchor (`boundary.runAnchor`). */
  anchor: string;
  site: string;
  discriminant: string;
}): string {
  return `${KEY_PREFIX[opts.kind]}:${opts.anchor}:${opts.site}:${opts.discriminant}`;
}

/**
 * Record `key` as used in this run, throwing loudly if it collides with a key an
 * earlier side effect in the same run already derived. A collision means two
 * genuinely-different sends/triggers resolved to the same key (e.g. the SAME
 * template sent twice under the SAME nearest label) — under the unique index the
 * second would be silently suppressed, so we fail fast at dev time instead. The
 * fix is to pass a distinct `idempotencyLabel` to one of them.
 */
export function registerKey(boundary: JourneyBoundary, key: string): void {
  if (boundary.seenKeys.has(key)) {
    throw new Error(
      `journey replay-safety: duplicate idempotency key "${key}" derived ` +
        "twice in one journey run. Two distinct sends/triggers collided on " +
        "the same key — pass a distinct `idempotencyLabel` to one of them.",
    );
  }
  boundary.seenKeys.add(key);
}
