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
   * Every `ctx.digest`/`ctx.throttle` SITE label seen so far in THIS run. Unlike
   * {@link seenKeys} (auto-derived send/trigger keys), these are the authored
   * site labels the primitives use to anchor their durable record. Reusing one
   * label for two distinct sites would make them share a record and silently
   * over-collapse, so {@link registerRecordLabel} throws loudly on a collision.
   */
  seenRecordLabels: Set<string>;
  /**
   * Layer-1 fast path: run `fn` through Hatchet's durable `memo` keyed by
   * `deps` when (and only when) the engine supports eviction; otherwise fall
   * through to a bare `fn()`. Belt-and-suspenders over the Layer-2 DB key — when
   * eviction is live the provider/ingest call is skipped before the DB is even
   * touched; when it isn't, Layer 2 still guarantees exactly-once.
   */
  memoize<T>(deps: unknown[], fn: () => Promise<T> | T): Promise<T>;
  /**
   * The enclosing journey's id (`meta.id`), threaded onto the boundary so the
   * tracked mailer can enforce `meta.suppress` at send time WITHOUT the send
   * call sites having to pass it. Optional so non-journey boundaries (tests,
   * harness contexts) compile unchanged. Undefined ⇒ the suppress guard is inert.
   */
  journeyId?: string;
  /**
   * The enclosing journey's `meta.suppress` resolved to milliseconds
   * (`durationToMs`). > 0 arms the tracked mailer's per-recipient min-gap
   * suppress guard for this journey's sends; 0 (the `{}`/zero-duration default)
   * disables it. Optional for the same reason as {@link journeyId}.
   */
  suppressMs?: number;
  /**
   * The enclosing journey's `meta.category` — the email-preference category
   * stamped on this journey's `sendEmail` sends, overriding the template's own
   * category (the standalone `sendEmail` has no journey reference of its own, so
   * the boundary is the only conduit for it). Undefined ⇒ the send falls back to
   * the built-in `journey` default. Optional so non-journey boundaries (tests,
   * harness contexts) compile unchanged.
   */
  category?: string;
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
    // Invoke `ctx.memo(...)` DIRECTLY — never via an extracted
    // `const memo = ctx.memo; memo(...)`, which drops the `this` binding. The
    // SDK's `memo` body opens with `this.throwIfCancelled()`, so an unbound call
    // throws "Cannot read properties of undefined (reading 'throwIfCancelled')"
    // the moment eviction is live (a hatchet-lite >= v0.80.0). This is the live
    // path for EVERY journey side effect (sendEmail / sendConnectorAction /
    // ctx.trigger), so the bug surfaces on the first send under such an engine.
    if (typeof ctx.memo === "function" && ctx.supportsEviction === true) {
      return ctx.memo(fn, deps);
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
 * Recover the `<site>` discriminant embedded in a journey SEND idempotency key
 * (`journeySend:<anchor>:<site>:<discriminant>`), given the replay-stable
 * `anchor` (`boundary.runAnchor`) and the `discriminant` (the send's
 * templateKey). Returns undefined when `key` is absent or is not a `journeySend:`
 * key with the expected anchor/discriminant framing.
 *
 * This is how the SEND transition log recovers the EXACT `site` the mailer used
 * when it derived the key via {@link deriveJourneyKey} — the SAME value
 * `buildJourneyGraph` uses for the send node id (`send:<site>`) — so the log row
 * joins the graph node WITHOUT recomputing the site (a recompute of
 * `currentLabel ?? templateKey` would miss an explicit `idempotencyLabel`). Site
 * strings may themselves contain `:` (e.g. `wait-event:foo`), so we strip the
 * exact prefix/suffix rather than split on `:`.
 */
export function parseJourneySendSite(opts: {
  key: string | null | undefined;
  anchor: string;
  discriminant: string;
}): string | undefined {
  if (!opts.key) return undefined;
  const prefix = `${KEY_PREFIX.send}:${opts.anchor}:`;
  const suffix = `:${opts.discriminant}`;
  if (
    !opts.key.startsWith(prefix) ||
    !opts.key.endsWith(suffix) ||
    opts.key.length <= prefix.length + suffix.length
  ) {
    return undefined;
  }
  return opts.key.slice(prefix.length, opts.key.length - suffix.length);
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

/**
 * Record a `ctx.digest`/`ctx.throttle` SITE label as used in this run, throwing
 * loudly if it collides with a label an earlier primitive call in the same run
 * already used. Two sites sharing a label would share one durable record and
 * silently over-collapse (a second digest folding into the first's window, a
 * throttle verdict bleeding across sites), so we fail fast at dev time instead.
 * No-op when `boundary` is undefined (a unit-test context outside a durable run).
 */
export function registerRecordLabel(
  boundary: JourneyBoundary | undefined,
  label: string,
): void {
  if (!boundary) return;
  if (boundary.seenRecordLabels.has(label)) {
    throw new Error(
      `journey replay-safety: the digest/throttle site label "${label}" was ` +
        "used twice in one journey run. Each ctx.digest/ctx.throttle call needs " +
        "a unique site — pass a distinct `label` to one of them.",
    );
  }
  boundary.seenRecordLabels.add(label);
}
