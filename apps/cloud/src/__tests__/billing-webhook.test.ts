import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../app/api/billing/webhook/route";
import { getFakeBilling } from "../billing";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, cloudAuditLog, organizations } from "../db/schema";
import { env } from "../env";
import { OrgService } from "../services/orgs";

/**
 * The route is what Stripe actually calls, so it is tested as an HTTP surface:
 * a real `Request` with a raw body, the process-wide billing provider (the fake
 * — `CLOUD_BILLING` defaults to it), and the real database underneath.
 *
 * Two rules matter more than the happy path:
 *  - a bad signature is a 400 that applied NOTHING, and
 *  - the handler is reachable without a session (Stripe has no cookie). The
 *    proxy matcher already excludes `/api`; the assertion below pins that,
 *    because a later matcher edit would otherwise silently break billing.
 */

const CELL = "billing-webhook-us-1";
const ORG = "billing-webhook-org";

const orgs = new OrgService(db);
const fake = getFakeBilling();

const WEBHOOK_URL = "http://localhost:3004/api/billing/webhook";

function post(
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return POST(new Request(WEBHOOK_URL, { method: "POST", body, headers }));
}

async function readOrg() {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, ORG));
  if (!row) throw new Error("missing org");
  return row;
}

async function auditActions(): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, ORG));
  return rows.map((r) => r.action).sort();
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
  await db.delete(cells).where(eq(cells.name, CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(cells).values({
    name: CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 50,
  });
  await orgs.create({ id: ORG, name: "Webhook Org", region: "us" });
});

beforeEach(() => {
  fake.reset();
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("POST /api/billing/webhook", () => {
  it("applies a verified checkout event and answers 200", async () => {
    const minted = fake.mintWebhook({
      type: "checkout_completed",
      organizationId: ORG,
      plan: "self_serve",
      customerRef: "cus_webhook",
    });

    const response = await post(minted.payload, minted.headers);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    const org = await readOrg();
    expect(org.plan).toBe("self_serve");
    expect(org.billingCustomerId).toBe("cus_webhook");
    expect(await auditActions()).toContain("billing.plan_changed");
  });

  it("rejects a tampered payload with 400 and applies NOTHING", async () => {
    const before = await readOrg();
    const minted = fake.mintWebhook({
      type: "subscription_canceled",
      organizationId: ORG,
    });

    const response = await post(`${minted.payload} `, minted.headers);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
    const after = await readOrg();
    expect(after.suspendedAt).toBeNull();
    expect(after.plan).toBe(before.plan);
  });

  it("records the rejection against the org when the payload names a real one", async () => {
    const minted = fake.mintWebhook({
      type: "payment_failed",
      organizationId: ORG,
    });

    await post(`${minted.payload} `, minted.headers);

    expect(await auditActions()).toContain("billing.webhook_rejected");
    // The rejection is a NOTE, not an application: no dunning clock started.
    expect((await readOrg()).dunningSince).toBeNull();
  });

  it("200s a verified event it does not act on", async () => {
    const signed = fake.sign(JSON.stringify({ type: "invoice.upcoming" }));
    const response = await post(signed.payload, signed.headers);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  it("200s an event for an organization this control plane does not have", async () => {
    const minted = fake.mintWebhook({
      type: "payment_failed",
      organizationId: "billing-webhook-ghost",
    });
    const response = await post(minted.payload, minted.headers);
    // Not an error Stripe can fix by retrying — acknowledge and move on.
    expect(response.status).toBe(200);
  });

  it("is not intercepted by the route guard", async () => {
    const { config } = await import("../../proxy");
    const [pattern] = config.matcher;
    if (!pattern) throw new Error("expected a matcher pattern");
    expect(new RegExp(`^${pattern}$`).test("/api/billing/webhook")).toBe(false);
  });
});
