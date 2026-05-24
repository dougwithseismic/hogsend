import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });

async function seed() {
  console.log("Seeding database...");

  const demoUserId = "seed-user-001";
  const demoOrgId = "seed-org-001";

  await db
    .insert(schema.user)
    .values({
      id: demoUserId,
      name: "Demo User",
      email: "demo@growthhog.dev",
      emailVerified: true,
    })
    .onConflictDoNothing();

  await db
    .insert(schema.organization)
    .values({
      id: demoOrgId,
      name: "GrowthHog Demo",
      slug: "growthhog-demo",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.member)
    .values({
      id: "seed-member-001",
      organizationId: demoOrgId,
      userId: demoUserId,
      role: "owner",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.emailPreferences)
    .values({
      userId: demoUserId,
      email: "demo@growthhog.dev",
      unsubscribedAll: false,
      categories: {},
    })
    .onConflictDoNothing();

  await db
    .delete(schema.userEvents)
    .where(sql`${schema.userEvents.properties}->>'source' = 'seed'`);

  await db.insert(schema.userEvents).values([
    {
      userId: demoUserId,
      event: "user.created",
      properties: { plan: "free", source: "seed" },
    },
    {
      userId: demoUserId,
      event: "feature.used",
      properties: { feature: "dashboard", source: "seed" },
    },
  ]);

  console.log("Seeding complete.");
}

await seed();
await client.end();
process.exit(0);
