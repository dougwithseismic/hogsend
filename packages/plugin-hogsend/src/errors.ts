/**
 * Typed relay failures.
 *
 * The relay answers `{ error: <slug>, message, … }` on every refusal, and the
 * WHOLE point of the fail-loud decision (DECISIONS §6) is that the slug and the
 * reason survive the wire so the journey records a real sentence rather than
 * "send failed". These classes are that survival: nothing is flattened into a
 * bare `Error`, and nothing is silently rerouted.
 *
 * **This wire NEVER retries.** `retryable` is advisory metadata for the caller;
 * the durable task layer owns retry policy. A 4xx is never retryable — the same
 * law the rest of the stack holds — with the two exceptions the relay itself
 * invites by returning a `Retry-After`: `409 send_in_progress` (an identical
 * send is at the wire right now) and `429 rate_limited` (the burst window will
 * roll).
 */

/** Statuses the relay itself asks the caller to retry. */
const RETRYABLE_4XX = new Set([409, 429]);

/** The relay's fallback slug when it answered with something unparseable. */
const UNKNOWN_SLUG = "send_failed";

export interface HogsendRelayErrorInit {
  status: number;
  /** The relay's `error` slug, or `send_failed` when the body was unreadable. */
  error?: string;
  message: string;
  /** The relay's parsed body, verbatim. `undefined` when it was not JSON. */
  body?: unknown;
  /** Parsed `Retry-After`, in seconds. `null` when the header was absent. */
  retryAfterSeconds?: number | null;
}

/** A refusal from the Hogsend Cloud send relay, with its shape intact. */
export class HogsendRelayError extends Error {
  readonly status: number;
  /** The relay's error slug — `tenant_paused`, `rate_limited`, … */
  readonly error: string;
  readonly body: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(init: HogsendRelayErrorInit) {
    super(init.message);
    this.name = "HogsendRelayError";
    this.status = init.status;
    this.error = init.error || UNKNOWN_SLUG;
    this.body = init.body;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  /**
   * Advisory only — this provider never retries. `true` for 5xx and for the two
   * 4xx the relay explicitly invites a retry on; every other 4xx is `false`.
   */
  get retryable(): boolean {
    return this.status >= 500 || RETRYABLE_4XX.has(this.status);
  }
}

/**
 * `403 tenant_paused` — the fail-closed gate (DECISIONS §6).
 *
 * Nothing was sent and nothing was queued. There is deliberately NO fallback
 * provider and NO retry: a tenant AWS flagged for abuse does not get an escape
 * hatch. The reason travels verbatim so Studio and the journey can say WHY.
 */
export class HogsendRelayPausedError extends HogsendRelayError {
  /** The relay's human reason for the pause. `null` when it recorded none. */
  readonly reason: string | null;
  /** ISO 8601 instant the pause was recorded. `null` when unknown. */
  readonly pausedAt: string | null;

  constructor(
    init: HogsendRelayErrorInit & {
      reason?: string | null;
      pausedAt?: string | null;
    },
  ) {
    // The reason is folded into the message so it survives even a caller that
    // only logs `error.message`.
    super({
      ...init,
      message: init.reason ? `${init.message} ${init.reason}` : init.message,
    });
    this.name = "HogsendRelayPausedError";
    this.reason = init.reason ?? null;
    this.pausedAt = init.pausedAt ?? null;
  }
}

/** One entry of the relay's batch response, positional with the request. */
export type HogsendRelayBatchResult =
  | { status: "sent"; id: string; idempotent?: true }
  | { status: "failed"; error: string; message: string };

/** A per-item failure, with the index of the input item it belongs to. */
export interface HogsendRelayBatchFailure {
  index: number;
  error: string;
  message: string;
}

/**
 * At least one item of a batch did not send.
 *
 * The `EmailProvider` contract's `SendResult` can only express an id, so a
 * failed item has no honest representation in the returned array — and
 * fabricating an empty id would report a delivery that never happened. So the
 * batch throws, carrying EVERY positional outcome, which loses nothing: the
 * caller can still read the ids that did send.
 *
 * Retrying the whole batch is safe and cheap. The relay claims idempotency PER
 * ITEM, so the already-sent items come back as replays (`idempotent: true`,
 * never re-sent) and only the failures reach SES again.
 */
export class HogsendRelayBatchError extends HogsendRelayError {
  /** Every outcome, positional with the input items. */
  readonly results: HogsendRelayBatchResult[];
  /** Just the failures, each carrying its input index. */
  readonly failures: HogsendRelayBatchFailure[];

  constructor(init: {
    results: HogsendRelayBatchResult[];
    failures: HogsendRelayBatchFailure[];
  }) {
    const first = init.failures[0];
    super({
      status: 200,
      error: first?.error ?? UNKNOWN_SLUG,
      message: `Hogsend relay: ${init.failures.length} of ${init.results.length} batch messages failed (${first?.error ?? UNKNOWN_SLUG}: ${first?.message ?? "no detail"})`,
    });
    this.name = "HogsendRelayBatchError";
    this.results = init.results;
    this.failures = init.failures;
  }

  /** A partial batch failure is never a blanket retry decision. */
  override get retryable(): boolean {
    return false;
  }
}
