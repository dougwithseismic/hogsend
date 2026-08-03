import { db, sqlClient } from "../src/db";
import { runCloudMigrations } from "../src/db/migrator";
import { cells } from "../src/db/schema";
import { env } from "../src/env";
import { encryptSecretPayload } from "../src/lib/crypto";

/**
 * The one row a fresh clone cannot sign up without.
 *
 * Placement (`OrgService.create`) refuses a shared-tier org in a region with no
 * accepting cell, so a developer who has only run migrations gets
 * `illegal_region` on the create-org form and no way forward. This seeds a
 * single US dev cell pointing at the local compose stack.
 *
 * Idempotent: `cells.name` is unique and the insert is
 * `onConflictDoNothing`, so re-running changes nothing. It is DEV data — the
 * DSN is the local compose superuser and the Hatchet URL is localhost; nothing
 * here is safe or meaningful in a deployed environment.
 */

const DEV_CELL_NAME = "us-dev-1";
/** The compose Postgres (docker-compose `postgres`, host port 5434). */
const DEV_CLUSTER_DSN =
  "postgres://growthhog:growthhog@localhost:5434/postgres";
/** The compose Hatchet-Lite gRPC endpoint. */
const DEV_HATCHET_URL = "localhost:7077";

async function seedDev(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "seed:dev writes localhost infrastructure rows; refusing to run with NODE_ENV=production",
    );
  }

  await runCloudMigrations(env.CLOUD_DATABASE_URL);

  const inserted = await db
    .insert(cells)
    .values({
      name: DEV_CELL_NAME,
      region: "us",
      // Cell DSNs live encrypted at rest, same as tenant provider keys.
      sharedClusterDsn: encryptSecretPayload(DEV_CLUSTER_DSN),
      sharedHatchetUrl: DEV_HATCHET_URL,
      accepting: true,
      maxTenants: 100,
    })
    .onConflictDoNothing({ target: cells.name })
    .returning({ id: cells.id });

  console.log(
    inserted.length > 0
      ? `[cloud] seeded cell "${DEV_CELL_NAME}" (${inserted[0]?.id})`
      : `[cloud] cell "${DEV_CELL_NAME}" already present`,
  );
}

seedDev()
  .then(async () => {
    await sqlClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[cloud] Seed failed:", err);
    await sqlClient.end().catch(() => {});
    process.exit(1);
  });
