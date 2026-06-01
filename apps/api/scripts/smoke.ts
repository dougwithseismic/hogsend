/**
 * End-to-end smoke test for the @hogsend/engine carve.
 *
 * Boots the thin consumer (createHogsendClient + createApp + createWorker) exactly
 * like production, then exercises the full carved pipeline against live infra
 * (TimescaleDB, Redis, Hatchet):
 *
 *   1. Engine factories wire up from injected content (journeys, sources).
 *   2. /v1/health reports the DB component up.
 *   3. The admin API lists the injected journeys (content injection works).
 *   4. Outgoing HTML is link-rewritten + open-pixel injected (tracking carve).
 *   5. An ingested `test.signup` event routes through Hatchet to the
 *      test-onboarding journey, which runs to completion — proving
 *      ingest → Hatchet → createWorker task → defineJourney → ctx.trigger.
 *
 * Run:  cd apps/api && pnpm smoke
 *
 * Requires `docker compose up -d` and a schema-present DB. This dev DB was set
 * up via `db:push`, so the migration ledger is behind the bundled migrations
 * (the documented db:push gotcha in docs/UPGRADING.md); the script sets
 * SKIP_SCHEMA_CHECK so the boot guard does not block a physically-correct DB.
 */
import {
  emailSends,
  journeyStates,
  trackedLinks,
  userEvents,
} from "@hogsend/db";
import {
  createApp,
  createHogsendClient,
  createWorker,
  prepareTrackedHtml,
} from "@hogsend/engine";
import { and, desc, eq } from "drizzle-orm";
import { templates } from "../src/emails/index.js";
import { journeys } from "../src/journeys/index.js";
import { webhookSources } from "../src/webhook-sources/index.js";

process.env.SKIP_SCHEMA_CHECK = "true";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n── Hogsend engine smoke test ──\n");

  // 1. Engine factories boot from injected content.
  const client = createHogsendClient({ journeys, email: { templates } });
  const app = createApp(client, { webhookSources });
  const worker = createWorker({ container: client, journeys });
  check("createHogsendClient / createApp / createWorker wired", true);
  check(
    `journey registry populated (${client.registry.count()} journeys)`,
    client.registry.count() === journeys.length,
    `expected ${journeys.length}, got ${client.registry.count()}`,
  );

  // 2. Health — DB component up.
  const healthRes = await app.request("/v1/health");
  const health = (await healthRes.json()) as {
    status: string;
    components: { database: { status: string } };
  };
  check(
    `health reachable (status=${health.status}, db=${health.components.database.status})`,
    healthRes.status === 200 && health.components.database.status === "up",
  );

  // 3. Admin lists the injected journeys.
  const adminRes = await app.request("/v1/admin/journeys", {
    headers: { Authorization: `Bearer ${client.env.ADMIN_API_KEY}` },
  });
  const adminBody = (await adminRes.json()) as { journeys: { id: string }[] };
  check(
    "admin API lists injected journeys",
    adminRes.status === 200 &&
      adminBody.journeys.some((j) => j.id === "test-onboarding"),
  );

  // 4. Tracking carve — link rewrite + open pixel (needs a real email send row,
  // tracked_links FKs to email_sends).
  const [emailSend] = await client.db
    .insert(emailSends)
    .values({
      fromEmail: "smoke@hogsend.test",
      toEmail: "recipient@smoke.test",
      subject: "smoke",
    })
    .returning({ id: emailSends.id });
  const tracked = await prepareTrackedHtml({
    html: '<html><body><a href="https://example.com/x">Go</a></body></html>',
    db: client.db,
    emailSendId: emailSend.id,
    baseUrl: client.env.API_PUBLIC_URL,
  });
  await client.db
    .delete(trackedLinks)
    .where(eq(trackedLinks.emailSendId, emailSend.id));
  await client.db.delete(emailSends).where(eq(emailSends.id, emailSend.id));
  check(
    "tracked HTML rewrites links",
    tracked.includes("/v1/t/c/") && !tracked.includes('href="https://example'),
  );
  check("tracked HTML injects open pixel", tracked.includes("/v1/t/o/"));

  // 5. Full journey end-to-end via Hatchet + worker.
  // worker.start() runs the Hatchet loop and only resolves on stop(), so we
  // launch it without awaiting and give it a moment to register its tasks.
  console.log("\n  starting worker (Hatchet)…");
  worker.start().catch((err) => {
    console.error("  worker.start() error:", err);
  });
  await sleep(5000); // let the worker register tasks with Hatchet

  const userId = `smoke-${process.pid}-${process.hrtime.bigint()}`;
  console.log(`  firing test.signup for ${userId}…`);
  const ingestRes = await app.request("/v1/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${client.env.ADMIN_API_KEY}`,
    },
    body: JSON.stringify({
      event: "test.signup",
      userId,
      userEmail: `${userId}@smoke.test`,
      properties: { plan: "pro" },
    }),
  });
  check(
    `ingest accepted test.signup (${ingestRes.status})`,
    ingestRes.status === 202,
  );

  // Poll for the journey to reach a terminal state.
  let state: { status: string } | undefined;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const rows = await client.db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, userId),
          eq(journeyStates.journeyId, "test-onboarding"),
        ),
      )
      .orderBy(desc(journeyStates.createdAt))
      .limit(1);
    state = rows[0];
    if (state && ["completed", "failed", "exited"].includes(state.status))
      break;
    if (state) process.stdout.write(`  …state=${state.status}\r`);
  }
  check(
    `journey ran to completion (status=${state?.status ?? "none"})`,
    state?.status === "completed",
  );

  // Downstream events fired by ctx.trigger should be stored.
  const events = await client.db
    .select({ event: userEvents.event })
    .from(userEvents)
    .where(eq(userEvents.userId, userId));
  const names = new Set(events.map((e) => e.event));
  check(
    `downstream events stored (${Array.from(names).join(", ") || "none"})`,
    names.has("journey.welcome_fired") && names.has("journey.pro_path"),
  );

  console.log("\n  stopping worker…");
  await worker.stop();
  await client.dbClient.end({ timeout: 5 });

  console.log(`\n── ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
