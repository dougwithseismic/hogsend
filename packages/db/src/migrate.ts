import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

console.log("Running migrations...");
await migrate(db, {
  migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
});
console.log("Migrations complete.");

await client.end();
process.exit(0);
