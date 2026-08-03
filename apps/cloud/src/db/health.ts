import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { appliedCount, bundledMigrations } from "./ledger";

export interface CloudHealth {
  status: "ok" | "degraded";
  db: "ok" | "error";
  migrations: "in_sync" | "pending";
}

/**
 * Liveness + schema readiness for the cloud control plane. NEVER throws and
 * never creates anything: an unreachable database is a reported state
 * (`degraded`), not a 500 — a health endpoint that dies with the database tells
 * you nothing a connection refusal wouldn't.
 *
 * Uses its own short-lived connection rather than the app pool so a saturated
 * pool can't make health hang.
 */
export async function checkCloudHealth(
  databaseUrl: string,
): Promise<CloudHealth> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
    // postgres-js retries forever by default on a refused socket; one attempt
    // is what a health probe wants.
    max_lifetime: 30,
    connection: { application_name: "hogsend-cloud-health" },
  });

  let db: CloudHealth["db"] = "error";
  let migrations: CloudHealth["migrations"] = "pending";
  try {
    await client`SELECT 1`;
    db = "ok";
    const applied = await appliedCount(drizzle(client));
    if (applied >= bundledMigrations().length) migrations = "in_sync";
  } catch {
    // Both legs collapse to the reported state above.
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }

  return {
    status: db === "ok" && migrations === "in_sync" ? "ok" : "degraded",
    db,
    migrations,
  };
}
