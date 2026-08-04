/**
 * THE DNS seam.
 *
 * A sibling of `SubstrateProvider`, and deliberately its own boundary rather
 * than another method on it. The substrate answers "where does this instance
 * run"; DNS answers "what name points at it". They are different vendors with
 * different credentials, different failure modes and different rate limits, and
 * the provisioning pipeline has to tell a Cloudflare 429 (back off) from a
 * Cloudflare 400 (park) exactly as it already does for the substrate.
 *
 * The same two rules as the substrate seam keep it portable:
 *  - The vendor's own record identifier lives inside `DnsRecordHandle.id`,
 *    which callers store and hand back and never parse.
 *  - Every method is async and single-object-in / result-object-out, so the
 *    interface widens without churning callers.
 *
 * The interface is intentionally tiny. Two writes and one read is everything
 * the hostname story needs; anything larger would be a DNS management product
 * nobody asked for.
 */

/** A record to create, stated as the outcome rather than as a vendor payload. */
export interface DnsRecordSpec {
  /** The fully-qualified name, e.g. `acme.hogsend.com`. */
  hostname: string;
  /** What the name should resolve through — the substrate's own hostname. */
  target: string;
}

/**
 * A record that exists. `id` is the vendor's, and opaque: the control plane
 * persists it so teardown can delete exactly the record it created, rather
 * than searching the zone by name and hoping.
 */
export interface DnsRecordHandle {
  id: string;
  hostname: string;
}

/**
 * How full the zone is.
 *
 * This is on the seam because it is a real operational ceiling, not a curiosity:
 * a Cloudflare Free zone created after September 2024 holds 200 records, we
 * write one per instance, and the failure mode without this read is that
 * onboarding stops working at an unannounced number.
 */
export interface DnsCapacity {
  used: number;
  /** null when the vendor does not report a limit. Never guessed. */
  limit: number | null;
}

/**
 * The seam. Implementations: `FakeDns` (deterministic, in-memory — every test
 * and local dev) and `CloudflareDns`. Both must pass `describeDnsContract`.
 */
export interface DnsProvider {
  /** Stable id for logs and audit rows. Never branched on by business logic. */
  readonly id: string;
  /**
   * Create the record, or return the existing one unchanged when it already
   * points where it should.
   *
   * Idempotent by hostname, and it has to be: the provisioning pipeline
   * re-drives a failed step, and the second pass must not fail on a record the
   * first pass already wrote. A hostname that exists pointing somewhere ELSE is
   * a conflict, not an update — see `DnsRecordConflictError`.
   */
  ensureRecord(spec: DnsRecordSpec): Promise<DnsRecordHandle>;
  /**
   * Delete the record. Deleting one that is already gone SUCCEEDS: teardown
   * runs more than once, and a second destroy must not fail on the work the
   * first one finished.
   */
  deleteRecord(handle: Pick<DnsRecordHandle, "id">): Promise<void>;
  readCapacity(): Promise<DnsCapacity>;
}

/**
 * The only error type that crosses the seam.
 *
 * `retryable` carries the same weight it does on `SubstrateError`: the pipeline
 * decides "back off" or "park in error" from this flag alone, so the
 * implementation is the one place that knows a 429 from a 400. Default `false`
 * — an implementation opts IN to a retry, because retrying a permanent failure
 * burns the attempt budget for nothing.
 */
export class DnsError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The hostname is already taken by a record pointing somewhere else.
 *
 * Never retryable, and never silently overwritten: the existing record may be
 * another tenant's live instance, and repointing it would take their tracked
 * links and Studio down to fix our collision.
 */
export class DnsRecordConflictError extends DnsError {
  constructor(
    readonly hostname: string,
    readonly existingTarget: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `"${hostname}" already resolves to "${existingTarget}"; refusing to repoint a record this zone did not create for it`,
      { retryable: false, cause: options.cause },
    );
  }
}
