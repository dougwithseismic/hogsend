import { createDatabase, journeyBlueprints } from "@hogsend/db";

/**
 * Seeds one example Journey Blueprint — the JSON-authored companion to the
 * `welcome` code journey (src/journeys/welcome.ts). Same primitives (a
 * durable sleep, a decision, a send), same registered template, but stored
 * as a `journey_blueprints` row instead of committed code. Run it with:
 *
 *   pnpm seed:example-blueprint
 *
 * Blueprints are normally created live via the create_journey_blueprint MCP
 * tool (or POST /v1/admin/blueprints) — this script does the equivalent DB
 * write directly so a fresh scaffold has one to look at in Studio →
 * Journeys immediately, without needing an agent/API call first. See the
 * hogsend-authoring-journey-blueprints skill for how to author your own.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const BLUEPRINT_ID = "activation-nudge-blueprint";

const { db, client } = createDatabase({ url: databaseUrl });

async function seed() {
  console.log("Seeding example Journey Blueprint...");

  await db
    .insert(journeyBlueprints)
    .values({
      id: BLUEPRINT_ID,
      name: "Activation nudge (example blueprint)",
      description:
        "JSON-authored companion to the `welcome` code journey — same primitives, stored as data instead of code. Edit it via the create_journey_blueprint/update_journey_blueprint MCP tools, not a PR.",
      status: "enabled",
      triggerEvent: "feature.activated",
      entryLimit: "once",
      suppress: {},
      graph: {
        journeyId: BLUEPRINT_ID,
        nodes: [
          { id: "start", type: "start", title: "feature.activated" },
          {
            id: "sleep-2d",
            type: "sleep",
            title: "Wait 2 days",
            meta: { duration: { hours: 48 } },
          },
          {
            id: "check-used-again",
            type: "decision",
            title: "Used the feature again?",
            meta: {
              conditions: [
                {
                  type: "event",
                  eventName: "feature.used",
                  check: "exists",
                },
              ],
            },
          },
          {
            id: "send-nudge",
            type: "send",
            title: "Send activation nudge",
            meta: { template: "activation/nudge" },
          },
          { id: "end-ok", type: "end-completed", title: "Done" },
        ],
        edges: [
          { id: "e1", source: "start", target: "sleep-2d" },
          { id: "e2", source: "sleep-2d", target: "check-used-again" },
          {
            id: "e3",
            source: "check-used-again",
            target: "end-ok",
            kind: "conditional-true",
          },
          {
            id: "e4",
            source: "check-used-again",
            target: "send-nudge",
            kind: "conditional-false",
          },
          { id: "e5", source: "send-nudge", target: "end-ok" },
        ],
      },
      source: "api",
      createdBy: "create-hogsend scaffold",
    })
    .onConflictDoNothing();

  console.log(
    `Seeded blueprint "${BLUEPRINT_ID}" — visible in Studio → Journeys.`,
  );
  await client.end();
}

await seed();
