import { createHash } from "node:crypto";
import type { EmailProvider, SendEmailOptions } from "@hogsend/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { apiKeys, contacts, emailSends, trackedLinks } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { templates } = await import("../emails/index.js");
// The real app lists (incl. `product-updates`) — wired so the marketing
// template's `product-updates` category resolves to a defined list, matching
// `src/index.ts` (the container boot-guard rejects an unknown category).
const { lists } = await import("../lists/index.js");

// A fake provider so the engine-owned tracked mailer runs its FULL pipeline
// (preference check → email_sends insert → tracked-html link rewrite →
// tracked_links insert → status "sent") WITHOUT any network call. `send`
// returns a deterministic provider id.
const providerSend = vi.fn(async (_opts: SendEmailOptions) => ({
  id: "fake-resend-id",
}));
const fakeProvider: EmailProvider = {
  send: providerSend,
  sendBatch: vi.fn(async () => ({ results: [] })),
  verifyWebhook: vi.fn(() => {
    throw new Error("not used");
  }),
  parseWebhook: vi.fn(() => {
    throw new Error("not used");
  }),
};

const container = createHogsendClient({
  email: { provider: fakeProvider, templates },
  lists,
});
const app = createApp(container);
const { db } = container;

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const INGEST_KEY = "hsk_test_emails_ingest_only_key";
let ingestKeyId: string;

const RUN = `emdp-${Date.now()}`;
const TO_EMAIL = `${RUN}-to@example.com`;
const NOEMAIL_USER = `${RUN}-noemail-user`;

beforeAll(async () => {
  // An ingest-scoped (NOT full-admin) key for the skipPreferenceCheck 403 path.
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: "emails-dataplane ingest",
      keyPrefix: INGEST_KEY.slice(0, 8),
      keyHash: hashKey(INGEST_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  ingestKeyId = row?.id ?? "";

  // A contact with an external_id but NO email (the 404 recipient path).
  await db
    .insert(contacts)
    .values({ externalId: NOEMAIL_USER, email: null })
    .onConflictDoNothing();
});

afterAll(async () => {
  const sends = await db
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(eq(emailSends.toEmail, TO_EMAIL));
  for (const s of sends) {
    await db.delete(trackedLinks).where(eq(trackedLinks.emailSendId, s.id));
    await db.delete(emailSends).where(eq(emailSends.id, s.id));
  }
  await db.delete(contacts).where(eq(contacts.externalId, NOEMAIL_USER));
  if (ingestKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, ingestKeyId));
});

describe("POST /v1/emails", () => {
  it("sends via a named template and records a tracking row (link rewrite)", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
      }),
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.emailSendId).toBeTruthy();
    expect(body.status).toBe("sent");

    // The provider was actually invoked (with tracked html, not the raw react).
    expect(providerSend).toHaveBeenCalled();
    const sendArg = providerSend.mock.calls.at(-1)?.[0];
    expect(sendArg?.html).toBeDefined();

    // The engine-owned mailer wrote the email_sends row (journeyless — no
    // journeyStateId) so §5 tracking runs.
    const [sendRow] = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.id, body.emailSendId));
    expect(sendRow).toBeDefined();
    expect(sendRow?.templateKey).toBe("welcome");
    expect(sendRow?.journeyStateId).toBeNull();

    // The welcome template carries links, so prepareTrackedHtml created at least
    // one tracked_links row for this send.
    const links = await db
      .select()
      .from(trackedLinks)
      .where(eq(trackedLinks.emailSendId, body.emailSendId));
    expect(links.length).toBeGreaterThan(0);
  });

  it("returns 400 for an unknown template", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "does-not-exist",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither `to` nor `userId` is supplied", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({ template: "welcome" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 for skipPreferenceCheck without a full-admin key", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INGEST_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
        skipPreferenceCheck: true,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a userId with no resolvable email", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        userId: NOEMAIL_USER,
        template: "welcome",
        props: { name: "Ada" },
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an unknown category (silent opt-in / suppression bypass)", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
        category: "not-a-real-list",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not-a-real-list");
  });

  it("accepts a registered list as the category", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
        category: "product-updates",
      }),
    });
    expect(res.status).toBe(202);
  });

  it("accepts a reserved built-in category (transactional)", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
        category: "transactional",
      }),
    });
    expect(res.status).toBe(202);
  });

  it("accepts a request with no category (template default applies)", async () => {
    const res = await app.request("/v1/emails", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        to: TO_EMAIL,
        template: "welcome",
        props: { name: "Ada" },
      }),
    });
    expect(res.status).toBe(202);
  });
});
