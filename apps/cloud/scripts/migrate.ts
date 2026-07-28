import { runCloudMigrations } from "../src/db/migrator";
import { env } from "../src/env";

runCloudMigrations(env.CLOUD_DATABASE_URL)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cloud] Migration failed:", err);
    process.exit(1);
  });
