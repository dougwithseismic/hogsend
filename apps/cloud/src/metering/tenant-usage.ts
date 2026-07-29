import postgres from "postgres";

/**
 * The metering READER: what one tenant database counted this month.
 *
 * This is the only place in the control plane that opens a connection to a
 * TENANT's database, and the posture it holds is the whole point of the module:
 *
 *  - **Read-only, and enforced by the server rather than by our good manners.**
 *    The session starts with `default_transaction_read_only=on`, so every
 *    implicit transaction this connection opens is read-only and ANY write —
 *    including one introduced by a future edit to this file — is refused by
 *    Postgres with `25006 read_only_sql_transaction`. The invariant survives a
 *    careless change; a comment saying "only SELECTs please" would not.
 *  - **Only two SELECTs, both aggregates.** No tenant row ever crosses back
 *    into the control plane — a count does. Metering must not become a covert
 *    read channel onto customer data.
 *  - **Tiny and short-lived.** `max: 1` (one connection per tenant, and the
 *    sweep visits tenants in sequence), a connect timeout, a statement timeout,
 *    and an unconditional `end()` in a `finally`. A fleet sweep that leaked a
 *    connection per stack would exhaust a shared cell's `max_connections` long
 *    before it exhausted the tenant list.
 *  - **It throws rather than guessing.** An unreachable tenant is the sweep's
 *    problem to record and step over (see `metering/sweep.ts`); returning zeroes
 *    here would silently under-bill a tenant whose database was merely down.
 */

/** One connection, because the sweep is sequential — see the module note. */
const MAX_CONNECTIONS = 1;
/** A dead host must fail the stack, not the sweep. Seconds (postgres-js). */
const CONNECT_TIMEOUT_SECONDS = 10;
/** A count on a big tenant table is still an index/seq scan; cap it. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Bounded drain on the way out; a hung close must not stall the fleet. */
export const CLOSE_TIMEOUT_SECONDS = 5;

export interface TenantUsageWindow {
  /** The tenant DSN, already decrypted. NEVER logged. */
  dsn: string;
  /** Inclusive start of the billing period (UTC). */
  since: Date;
  /** Exclusive end of the billing period (UTC). */
  until: Date;
}

export interface TenantUsageCounts {
  /** Rows in `user_events` with `occurred_at` inside the window. */
  events: number;
  /**
   * Rows in `email_sends` with `sent_at` inside the window.
   *
   * `sent_at` and not `created_at`: the engine writes an `email_sends` row for
   * sends it then SUPPRESSES (unsubscribed, capped, no consent) and stamps
   * `sent_at` only when the provider actually accepted the message. Billing a
   * tenant for mail their own preference rules stopped would be a charge for
   * nothing.
   */
  emails: number;
}

/**
 * The seam the sweep depends on. Injected so tests meter without a tenant
 * database, and so a future topology (a pooler, a warehouse rollup) is a swap
 * here rather than a rewrite of the sweep.
 */
export type TenantUsageReader = (
  window: TenantUsageWindow,
) => Promise<TenantUsageCounts>;

/** Postgres returns `count(*)` as a bigint, which postgres-js hands back as a
 * string. Counts stay far inside Number.MAX_SAFE_INTEGER. */
function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Open a metering connection to a tenant database.
 *
 * Exported so the read-only guard is TESTABLE as itself: a test opens one of
 * these and proves Postgres refuses a write through it (`25006`). A posture
 * asserted only by reading the SELECTs below would be one careless edit away
 * from being untrue.
 *
 * The caller owns closing it.
 */
export function openTenantReader(dsn: string): postgres.Sql {
  return postgres(dsn, {
    max: MAX_CONNECTIONS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: 1,
    // Metering reads a handful of one-shot aggregates per month; caching a
    // prepared plan per connection buys nothing and upsets poolers.
    prepare: false,
    onnotice: () => {},
    connection: {
      application_name: "hogsend-cloud-metering",
      // THE read-only guard. A startup parameter, so it is in force before the
      // first statement rather than after a SET we might forget to send.
      default_transaction_read_only: true,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
  });
}

/**
 * Count one tenant's metered rows for the window. Throws on an unreachable or
 * unreadable database.
 */
export const readTenantUsage: TenantUsageReader = async ({
  dsn,
  since,
  until,
}) => {
  const sql = openTenantReader(dsn);

  try {
    const [events] = await sql`
      SELECT count(*) AS count
      FROM user_events
      WHERE occurred_at >= ${since} AND occurred_at < ${until}
    `;
    const [emails] = await sql`
      SELECT count(*) AS count
      FROM email_sends
      WHERE sent_at >= ${since} AND sent_at < ${until}
    `;
    return {
      events: toCount(events?.count),
      emails: toCount(emails?.count),
    };
  } finally {
    await sql.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
};
