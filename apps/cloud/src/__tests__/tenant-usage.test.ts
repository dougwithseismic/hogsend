import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlClient } from "../db";
import { env } from "../env";
import { openTenantReader, readTenantUsage } from "../metering/tenant-usage";

/**
 * The tenant reader, against a REAL Postgres carrying real `user_events` and
 * `email_sends` tables.
 *
 * The fixture lives in the `public` schema of the control-plane test database
 * — the control plane's own tables are in `cloud`, so the two cannot collide —
 * and is created and dropped by this suite. That is deliberate: what is under
 * test is SQL and a connection posture, and both are only true against a
 * server. A mock would have proved that the strings we wrote are the strings we
 * wrote.
 *
 * The read-only claim is tested as itself: a write is attempted THROUGH a
 * metering connection and must be refused by Postgres (`25006`). Metering that
 * could write to a tenant's database would be the single worst bug available in
 * this module, and "we only wrote SELECTs" is an assertion about today's code
 * rather than about the connection.
 */

const SINCE = new Date("2026-03-01T00:00:00.000Z");
const UNTIL = new Date("2026-04-01T00:00:00.000Z");

async function createFixture(): Promise<void> {
  await sqlClient.unsafe(`
    CREATE TABLE IF NOT EXISTS public.user_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public.email_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    );
  `);
  await sqlClient.unsafe(`
    TRUNCATE public.user_events, public.email_sends;
    INSERT INTO public.user_events (occurred_at) VALUES
      ('2026-03-01T00:00:00Z'),
      ('2026-03-15T12:00:00Z'),
      ('2026-03-31T23:59:59Z'),
      -- Outside the window on both sides.
      ('2026-02-28T23:59:59Z'),
      ('2026-04-01T00:00:00Z');
    INSERT INTO public.email_sends (created_at, sent_at) VALUES
      ('2026-03-02T00:00:00Z', '2026-03-02T00:00:01Z'),
      ('2026-03-20T00:00:00Z', '2026-03-20T00:00:01Z'),
      -- Created this month but never dispatched: suppressed by the tenant's own
      -- preference rules, and so not a billable send.
      ('2026-03-21T00:00:00Z', NULL),
      ('2026-04-02T00:00:00Z', '2026-04-02T00:00:01Z');
  `);
}

beforeAll(async () => {
  await createFixture();
});

afterAll(async () => {
  await sqlClient.unsafe(
    "DROP TABLE IF EXISTS public.user_events, public.email_sends;",
  );
  await sqlClient.end();
});

describe("readTenantUsage", () => {
  it("counts events by occurred_at inside the half-open window", async () => {
    const counts = await readTenantUsage({
      dsn: env.CLOUD_DATABASE_URL,
      since: SINCE,
      until: UNTIL,
    });

    // `since` inclusive, `until` exclusive: 3 of the 5 rows.
    expect(counts.events).toBe(3);
  });

  it("counts only emails that were actually sent", async () => {
    const counts = await readTenantUsage({
      dsn: env.CLOUD_DATABASE_URL,
      since: SINCE,
      until: UNTIL,
    });

    // Two dispatched in March. The suppressed row (no `sent_at`) and April's
    // send are both excluded.
    expect(counts.emails).toBe(2);
  });

  it("throws rather than reporting zero when the database is unreachable", async () => {
    await expect(
      readTenantUsage({
        // Port 1 has nothing on it; a refusal is immediate.
        dsn: "postgres://nobody:nobody@127.0.0.1:1/nothing",
        since: SINCE,
        until: UNTIL,
      }),
    ).rejects.toThrow();
  });
});

describe("the metering connection", () => {
  it("is read-only at the SERVER, so any write is refused", async () => {
    const sql = openTenantReader(env.CLOUD_DATABASE_URL);
    try {
      await expect(
        sql`INSERT INTO public.user_events (occurred_at) VALUES (now())`,
      ).rejects.toMatchObject({ code: "25006" });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("leaves the tenant's rows exactly as it found them", async () => {
    const before =
      await sqlClient`SELECT count(*) AS count FROM public.user_events`;
    await readTenantUsage({
      dsn: env.CLOUD_DATABASE_URL,
      since: SINCE,
      until: UNTIL,
    });
    const after =
      await sqlClient`SELECT count(*) AS count FROM public.user_events`;

    expect(after[0]?.count).toBe(before[0]?.count);
  });
});
