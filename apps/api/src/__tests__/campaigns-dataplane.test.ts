import { createHash } from "node:crypto";
import type { EmailProvider, SendEmailOptions } from "@hogsend/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB (mirrors the other
// data-plane tests), overriding the vitest.config placeholder DATABASE_URL. The
// `sendCampaignTask.fn` body opens its OWN `createDatabase({ url:
// process.env.DATABASE_URL })` connection, so this MUST be set before the task
// runs.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors buckets.test.ts). The campaign task is
// a module-level `hatchet.task({ name, fn })` built off the ENGINE's own
// `lib/hatchet.ts` at import, AND the POST route dispatches it via
// `sendCampaignTask.runNoWait(...)` (immediate) or `.schedule(...)` (sendAt).
// We mock BOTH the engine's hatchet (so importing `@hogsend/engine` never dials
// a live gRPC engine and the task's `.fn` is preserved for direct invocation)
// AND the API's `../lib/hatchet.js`. The `...config` spread keeps
// `sendCampaignTask.fn` (the REAL campaign body) callable while
// `.runNoWait`/`.schedule` are no-op spies the route's dispatch lands on.
const { runNoWaitSpy, scheduleSpy, hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { campaignId: string }) => ({}));
  const schedule = vi.fn(
    async (_at: Date, _input: { campaignId: string }) => ({}),
  );
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait,
        schedule,
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return {
    runNoWaitSpy: runNoWait,
    scheduleSpy: schedule,
    hatchetMock: factory,
  };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  apiKeys,
  bucketMemberships,
  campaigns,
  contacts,
  emailPreferences,
  emailSends,
} = await import("@hogsend/db");
const { eq, like, or } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  createApp,
  createHogsendClient,
  defineBucket,
  defineList,
  reapStuckCampaignsTask,
  sendCampaignTask,
} = await import("@hogsend/engine");
const { templates } = await import("../emails/index.js");
// The real app's `product-updates` list — wired so the marketing template's
// `product-updates` category resolves to a defined list (matching `src/index.ts`;
// the container boot-guard rejects an unknown template category).
const { productUpdates } = await import("../lists/index.js");

// `sendCampaignTask.fn` is the real campaign body (the config-preserving mock
// kept it). It self-bootstraps db from process.env.DATABASE_URL and reads the
// engine email-service + list-registry singletons — both installed by the
// file-level `createHogsendClient` below.
const campaignTask = sendCampaignTask as unknown as {
  fn: (input: { campaignId: string }) => Promise<{
    status: string;
    totalRecipients?: number;
    sentCount?: number;
    skippedCount?: number;
    failedCount?: number;
  }>;
};

// A fake provider so the engine-owned tracked mailer runs its FULL pipeline
// (suppression/preference check → email_sends insert → status "sent") with NO
// network call. Each send returns a deterministic provider id, and the spy lets
// us assert exactly which recipients reached the provider.
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

// `broadcast` is an opt-in (defaultOptIn:false) list: a member is SUBSCRIBED only
// when `categories.broadcast === true`. This makes the polarity assertions sharp
// — categories without an explicit `true` are NOT recipients.
const broadcastList = defineList({
  id: "broadcast",
  name: "Broadcast",
  description: "Campaign broadcast list.",
  defaultOptIn: false,
});

// A simple property bucket for the bucket-audience campaign. The campaign
// resolves recipients from active `bucket_memberships` rows directly, so the
// criteria is irrelevant to the send path — only `bucketRegistry.has()` (route
// 404 guard) and the seeded active rows matter.
const RUN = `cdp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const BUCKET_ID = `${RUN}-vip`;
const vipBucket = defineBucket({
  meta: {
    id: BUCKET_ID,
    name: "VIP (campaign bucket)",
    enabled: true,
    criteria: {
      type: "property",
      property: "tier",
      operator: "eq",
      value: "vip",
    },
  },
});

// `createHogsendClient` installs the process singletons the task body reads
// (`setEmailService`, `buildListRegistry`) AND exposes the registries the route
// validates against. The fake provider keeps the send pipeline offline.
const container = createHogsendClient({
  email: { provider: fakeProvider, templates },
  lists: [broadcastList, productUpdates],
  buckets: [vipBucket],
});
const app = createApp(container);
const { db } = container;

// The bucket registry isn't installed as a process singleton by
// `createHogsendClient` in the same always-on way the list registry is, but the
// route reads it off the container; the campaign task resolves bucket recipients
// straight from `bucket_memberships`, so no bucket-registry singleton is needed
// for the task body. (Kept explicit for parity with the buckets test seam.)
buildBucketRegistry([vipBucket], "*");

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const READ_KEY = "hsk_test_campaigns_readonly_key";
const INGEST_KEY = "hsk_test_campaigns_ingest_key";
let readKeyId: string;
let ingestKeyId: string;

// List audience members (all carry an email_preferences row — a list scan is
// over email_preferences, so a contact with no prefs row is not reachable).
const SUB_EMAIL = `${RUN}-sub@example.com`; // categories.broadcast === true → SENT
const NOTSUB_EMAIL = `${RUN}-notsub@example.com`; // broadcast unset → SKIPPED (polarity)
const UNSUBALL_EMAIL = `${RUN}-unsuball@example.com`; // unsubscribedAll → SKIPPED
const SUPPRESSED_EMAIL = `${RUN}-suppressed@example.com`; // suppressed → SKIPPED

// Bucket audience members.
const BUCKET_USER = `${RUN}-bkt-active`;
const BUCKET_EMAIL = `${BUCKET_USER}@example.com`;
const BUCKET_LEFT_USER = `${RUN}-bkt-left`;
const BUCKET_LEFT_EMAIL = `${BUCKET_LEFT_USER}@example.com`;

const ALL_LIST_EMAILS = [
  SUB_EMAIL,
  NOTSUB_EMAIL,
  UNSUBALL_EMAIL,
  SUPPRESSED_EMAIL,
];

beforeAll(async () => {
  // Scoped keys for the auth matrix (minted directly, same sha256 the engine's
  // hashApiKey uses).
  const [readRow] = await db
    .insert(apiKeys)
    .values({
      name: "campaigns read-only",
      keyPrefix: READ_KEY.slice(0, 8),
      keyHash: hashKey(READ_KEY),
      scopes: ["read"],
    })
    .returning({ id: apiKeys.id });
  readKeyId = readRow?.id ?? "";

  const [ingestRow] = await db
    .insert(apiKeys)
    .values({
      name: "campaigns ingest",
      keyPrefix: INGEST_KEY.slice(0, 8),
      keyHash: hashKey(INGEST_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  ingestKeyId = ingestRow?.id ?? "";

  // List preference rows. The list scan reads email_preferences directly, so
  // every list audience member needs an explicit row.
  await db.insert(emailPreferences).values([
    {
      userId: `${RUN}-sub`,
      email: SUB_EMAIL,
      categories: { broadcast: true },
      unsubscribedAll: false,
      suppressed: false,
    },
    {
      // broadcast unset → NOT subscribed for an opt-in (defaultOptIn:false) list.
      userId: `${RUN}-notsub`,
      email: NOTSUB_EMAIL,
      categories: { other: true },
      unsubscribedAll: false,
      suppressed: false,
    },
    {
      // Subscribed to the category BUT globally unsubscribed → excluded.
      userId: `${RUN}-unsuball`,
      email: UNSUBALL_EMAIL,
      categories: { broadcast: true },
      unsubscribedAll: true,
      suppressed: false,
    },
    {
      // Subscribed to the category BUT suppressed (bounce/complaint) → excluded.
      userId: `${RUN}-suppressed`,
      email: SUPPRESSED_EMAIL,
      categories: { broadcast: true },
      unsubscribedAll: false,
      suppressed: true,
    },
  ]);

  // Bucket members: one active (a recipient), one left (must be ignored). Both
  // need a live contact for the email join.
  await db.insert(contacts).values([
    { externalId: BUCKET_USER, email: BUCKET_EMAIL },
    { externalId: BUCKET_LEFT_USER, email: BUCKET_LEFT_EMAIL },
  ]);
  await db.insert(bucketMemberships).values([
    {
      userId: BUCKET_USER,
      userEmail: BUCKET_EMAIL,
      bucketId: BUCKET_ID,
      status: "active",
    },
    {
      userId: BUCKET_LEFT_USER,
      userEmail: BUCKET_LEFT_EMAIL,
      bucketId: BUCKET_ID,
      status: "left",
      leftAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  // email_sends rows the campaigns created — scoped to THIS FILE's campaigns
  // (looked up by their audience ids before the campaign rows are deleted
  // below). A bare `campaign:%` sweep here would delete every campaign's send
  // history in a shared dev database.
  const testCampaigns = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      or(
        eq(campaigns.audienceId, "broadcast"),
        eq(campaigns.audienceId, BUCKET_ID),
      ),
    );
  for (const { id } of testCampaigns) {
    await db
      .delete(emailSends)
      .where(like(emailSends.idempotencyKey, `campaign:${id}:%`));
  }
  for (const email of [...ALL_LIST_EMAILS, BUCKET_EMAIL, BUCKET_LEFT_EMAIL]) {
    await db.delete(emailSends).where(eq(emailSends.toEmail, email));
    await db.delete(emailPreferences).where(eq(emailPreferences.email, email));
  }
  await db
    .delete(bucketMemberships)
    .where(eq(bucketMemberships.bucketId, BUCKET_ID));
  await db.delete(contacts).where(eq(contacts.externalId, BUCKET_USER));
  await db.delete(contacts).where(eq(contacts.externalId, BUCKET_LEFT_USER));
  // Campaigns this file created (list audience id `broadcast`, bucket id BUCKET_ID).
  await db.delete(campaigns).where(eq(campaigns.audienceId, "broadcast"));
  await db.delete(campaigns).where(eq(campaigns.audienceId, BUCKET_ID));
  if (readKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, readKeyId));
  if (ingestKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, ingestKeyId));
});

/** email_sends rows produced for a given campaign (by idempotency namespace). */
async function campaignSends(campaignId: string) {
  return db
    .select()
    .from(emailSends)
    .where(like(emailSends.idempotencyKey, `campaign:${campaignId}:%`));
}

// ===========================================================================
// (1) POST /v1/campaigns to a LIST creates a queued campaign
// ===========================================================================

describe("POST /v1/campaigns (list audience)", () => {
  it("creates a queued campaign and returns 202 + campaignId", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        name: "List blast",
        list: "broadcast",
        template: "welcome",
        props: { name: "Ada" },
      }),
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.campaignId).toBeTruthy();
    expect(body.status).toBe("queued");

    // The row was actually inserted in `queued` with the list audience.
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, body.campaignId));
    expect(row).toBeDefined();
    expect(row?.status).toBe("queued");
    expect(row?.audienceKind).toBe("list");
    expect(row?.audienceId).toBe("broadcast");
    expect(row?.templateKey).toBe("welcome");

    // The durable task was enqueued (fire-and-forget) — the route's
    // `.runNoWait` spy.
    expect(runNoWaitSpy).toHaveBeenCalled();
    const enqueued = runNoWaitSpy.mock.calls.at(-1)?.[0];
    expect(enqueued?.campaignId).toBe(body.campaignId);
  });
});

// ===========================================================================
// (2) sendCampaignTask sends ONLY to subscribed list members; the
//     not-subscribed, globally-unsubscribed, and suppressed members are SKIPPED
// ===========================================================================

describe("sendCampaignTask (list audience) — subscription polarity", () => {
  it("sends to subscribed members only; skips not-subscribed / unsubscribedAll / suppressed", async () => {
    providerSend.mockClear();

    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: "Polarity blast",
        status: "queued",
        audienceKind: "list",
        audienceId: "broadcast",
        templateKey: "welcome",
        props: { name: "Ada" },
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("failed to seed campaign");

    const result = await campaignTask.fn({ campaignId });

    expect(result.status).toBe("sent");

    // Exactly one recipient reached the provider — the subscribed member. The
    // not-subscribed member is filtered out by the list scan (polarity); the
    // unsubscribedAll + suppressed members are filtered by the scan's
    // pre-conditions, so they never reach a provider send at all.
    const sentTo = providerSend.mock.calls.map(
      (c) => (c[0] as SendEmailOptions).to,
    );
    expect(sentTo).toContain(SUB_EMAIL);
    expect(sentTo).not.toContain(NOTSUB_EMAIL);
    expect(sentTo).not.toContain(UNSUBALL_EMAIL);
    expect(sentTo).not.toContain(SUPPRESSED_EMAIL);

    // The campaign final counts: 1 sent, 0 skipped, 0 failed (the non-recipients
    // are filtered BEFORE the send loop, so they're not in totalRecipients).
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    expect(row?.status).toBe("sent");
    expect(row?.sentCount).toBe(1);
    expect(row?.failedCount).toBe(0);
    expect(row?.completedAt).not.toBeNull();
    expect(row?.startedAt).not.toBeNull();

    // email_sends: exactly one SENT row for the subscribed recipient, under the
    // campaign idempotency namespace; the excluded members have NO campaign row.
    const sends = await campaignSends(campaignId);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.toEmail).toBe(SUB_EMAIL);
    expect(sends[0]?.status).toBe("sent");
    expect(sends[0]?.idempotencyKey).toBe(
      `campaign:${campaignId}:${SUB_EMAIL}`,
    );
  });
});

// ===========================================================================
// (3) idempotent re-run does NOT create duplicate email_sends per recipient
// ===========================================================================

describe("sendCampaignTask idempotency (retry-safety)", () => {
  it("a re-run does not dispatch or record a duplicate send for the same recipient", async () => {
    providerSend.mockClear();

    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: "Idempotent blast",
        status: "queued",
        audienceKind: "list",
        audienceId: "broadcast",
        templateKey: "welcome",
        props: { name: "Ada" },
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("failed to seed campaign");

    // First run sends to the single subscribed recipient.
    await campaignTask.fn({ campaignId });
    const firstSendCalls = providerSend.mock.calls.length;
    expect(firstSendCalls).toBeGreaterThanOrEqual(1);
    const afterFirst = await campaignSends(campaignId);
    expect(afterFirst).toHaveLength(1);

    // A Hatchet retry re-runs the WHOLE loop. We must reset the campaign out of
    // its terminal `sent` state (the task short-circuits a terminal row) to
    // exercise the per-send idempotency key rather than the terminal-status
    // guard — this is the worst case for double-sends.
    await db
      .update(campaigns)
      .set({ status: "queued" })
      .where(eq(campaigns.id, campaignId));
    providerSend.mockClear();

    await campaignTask.fn({ campaignId });

    // The idempotency key `campaign:<id>:<email>` short-circuits the re-send to
    // the prior row — NO duplicate provider call.
    expect(providerSend).not.toHaveBeenCalled();

    // Still exactly ONE email_sends row for the recipient (no duplicate insert).
    const afterSecond = await campaignSends(campaignId);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.id).toBe(afterFirst[0]?.id);
  });
});

// ===========================================================================
// (4) BUCKET audience sends to active members only
// ===========================================================================

describe("sendCampaignTask (bucket audience)", () => {
  it("sends to active bucket members only, ignoring left members", async () => {
    providerSend.mockClear();

    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: "Bucket blast",
        status: "queued",
        audienceKind: "bucket",
        audienceId: BUCKET_ID,
        templateKey: "welcome",
        props: { name: "Ada" },
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("failed to seed campaign");

    const result = await campaignTask.fn({ campaignId });
    expect(result.status).toBe("sent");

    const sentTo = providerSend.mock.calls.map(
      (c) => (c[0] as SendEmailOptions).to,
    );
    expect(sentTo).toContain(BUCKET_EMAIL);
    // The "left" member is NOT a recipient.
    expect(sentTo).not.toContain(BUCKET_LEFT_EMAIL);

    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    expect(row?.status).toBe("sent");
    expect(row?.sentCount).toBe(1);
    expect(row?.totalRecipients).toBe(1);

    const sends = await campaignSends(campaignId);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.toEmail).toBe(BUCKET_EMAIL);
    expect(sends[0]?.status).toBe("sent");
  });
});

// ===========================================================================
// (5) GET /v1/campaigns/{id} returns status + counts
// ===========================================================================

describe("GET /v1/campaigns/{id}", () => {
  it("returns the campaign with status + counts", async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({
        name: "Gettable blast",
        status: "sent",
        audienceKind: "list",
        audienceId: "broadcast",
        templateKey: "welcome",
        totalRecipients: 5,
        sentCount: 3,
        skippedCount: 1,
        failedCount: 1,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning({ id: campaigns.id });
    const campaignId = campaign?.id;
    if (!campaignId) throw new Error("failed to seed campaign");

    const res = await app.request(`/v1/campaigns/${campaignId}`, {
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(campaignId);
    expect(body.name).toBe("Gettable blast");
    expect(body.status).toBe("sent");
    expect(body.audienceKind).toBe("list");
    expect(body.audienceId).toBe("broadcast");
    expect(body.templateKey).toBe("welcome");
    expect(body.totalRecipients).toBe(5);
    expect(body.sentCount).toBe(3);
    expect(body.skippedCount).toBe(1);
    expect(body.failedCount).toBe(1);
    expect(body.startedAt).not.toBeNull();
    expect(body.completedAt).not.toBeNull();
    expect(typeof body.createdAt).toBe("string");
  });

  it("returns 404 for an unknown campaign id", async () => {
    const res = await app.request(
      "/v1/campaigns/00000000-0000-0000-0000-000000000000",
      { headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (6) auth: 401 (no key), 403 (read-only), 202 (ingest)
// ===========================================================================

describe("POST /v1/campaigns auth + scope gate", () => {
  function body() {
    return JSON.stringify({
      list: "broadcast",
      template: "welcome",
      props: { name: "Ada" },
    });
  }

  it("returns 401 with NO key", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a read-only key (ingest scope required)", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${READ_KEY}`,
      },
      body: body(),
    });
    expect(res.status).toBe(403);
  });

  it("returns 202 for an ingest-scoped key", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: body(),
    });
    expect(res.status).toBe(202);
  });
});

// ===========================================================================
// (7) unknown list/bucket → 404, missing template → 400
// ===========================================================================

describe("POST /v1/campaigns validation", () => {
  it("returns 404 for an unknown list id", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        list: "no-such-list",
        template: "welcome",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown bucket id", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        bucket: "no-such-bucket",
        template: "welcome",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for an unknown template", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        list: "broadcast",
        template: "does-not-exist",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither list nor bucket is supplied", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({ template: "welcome" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when BOTH list and bucket are supplied (XOR)", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        list: "broadcast",
        bucket: BUCKET_ID,
        template: "welcome",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// (8) Scheduling: POST with a future sendAt creates a `scheduled` row and a
//     punctual Hatchet scheduled run — NOT an immediate enqueue
// ===========================================================================

describe("POST /v1/campaigns with sendAt (scheduling)", () => {
  it("creates a scheduled campaign and schedules the punctual run", async () => {
    runNoWaitSpy.mockClear();
    scheduleSpy.mockClear();

    const sendAt = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        name: "Scheduled blast",
        list: "broadcast",
        template: "welcome",
        sendAt: sendAt.toISOString(),
      }),
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe("scheduled");
    expect(body.scheduledAt).toBe(sendAt.toISOString());

    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, body.campaignId));
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduledAt?.toISOString()).toBe(sendAt.toISOString());

    // Punctual scheduled run created at the send instant; no immediate enqueue.
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const [at, input] = scheduleSpy.mock.calls[0] ?? [];
    expect((at as Date).toISOString()).toBe(sendAt.toISOString());
    expect((input as { campaignId: string }).campaignId).toBe(body.campaignId);
    expect(runNoWaitSpy).not.toHaveBeenCalled();
  });

  it("rejects a sendAt more than 60s in the past", async () => {
    const res = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        list: "broadcast",
        template: "welcome",
        sendAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("past");
  });

  it("an idempotent retry of a scheduled create resolves to the SAME campaign", async () => {
    const key = `${RUN}-sched-idem`;
    const sendAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const make = () =>
      app.request("/v1/campaigns", {
        method: "POST",
        headers: { ...ADMIN_HEADER, "Idempotency-Key": key },
        body: JSON.stringify({
          list: "broadcast",
          template: "welcome",
          sendAt,
        }),
      });

    const first = await (await make()).json();
    const second = await (await make()).json();
    expect(second.campaignId).toBe(first.campaignId);
    expect(second.status).toBe("scheduled");
    expect(second.scheduledAt).toBe(sendAt);
  });
});

// ===========================================================================
// (9) GET /v1/campaigns — list with status filter
// ===========================================================================

describe("GET /v1/campaigns (list)", () => {
  it("lists campaigns newest-first and honors the status filter", async () => {
    const res = await app.request("/v1/campaigns?status=scheduled&limit=100", {
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.campaigns)).toBe(true);
    expect(body.campaigns.length).toBeGreaterThan(0);
    for (const campaign of body.campaigns) {
      expect(campaign.status).toBe("scheduled");
    }
    // Newest first.
    const times = body.campaigns.map((c: { createdAt: string }) =>
      new Date(c.createdAt).getTime(),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

// ===========================================================================
// (10) Cancel: scheduled → canceled; terminal → 409; unknown → 404; and the
//      send task's terminal guard refuses to send a canceled campaign
// ===========================================================================

describe("POST /v1/campaigns/{id}/cancel", () => {
  it("cancels a scheduled campaign; a second cancel is a 409", async () => {
    const createRes = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        name: "To cancel",
        list: "broadcast",
        template: "welcome",
        sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    const { campaignId } = await createRes.json();

    const cancelRes = await app.request(`/v1/campaigns/${campaignId}/cancel`, {
      method: "POST",
      headers: ADMIN_HEADER,
    });
    expect(cancelRes.status).toBe(200);
    const canceled = await cancelRes.json();
    expect(canceled.status).toBe("canceled");
    expect(canceled.canceledAt).toBeTruthy();

    // The punctual run still fires later — the terminal guard must no-op it.
    providerSend.mockClear();
    const result = await campaignTask.fn({ campaignId });
    expect(result.status).toBe("canceled");
    expect(providerSend).not.toHaveBeenCalled();

    // A second cancel is a conflict, not a double-cancel.
    const again = await app.request(`/v1/campaigns/${campaignId}/cancel`, {
      method: "POST",
      headers: ADMIN_HEADER,
    });
    expect(again.status).toBe(409);
  });

  it("returns 404 for an unknown campaign id", async () => {
    const res = await app.request(
      "/v1/campaigns/00000000-0000-0000-0000-000000000000/cancel",
      { method: "POST", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (11) Early-fire guard: a scheduled run firing while `scheduledAt` is still
//      in the future (sendAt was moved later) skips without sending
// ===========================================================================

describe("sendCampaignTask early-fire guard", () => {
  it("skips a scheduled campaign whose scheduledAt is still in the future", async () => {
    const createRes = await app.request("/v1/campaigns", {
      method: "POST",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        name: "Not due yet",
        list: "broadcast",
        template: "welcome",
        sendAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    });
    const { campaignId } = await createRes.json();

    providerSend.mockClear();
    const result = await campaignTask.fn({ campaignId });
    expect(result.status).toBe("scheduled");
    expect(providerSend).not.toHaveBeenCalled();

    // Row untouched — still scheduled for later.
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    expect(row?.status).toBe("scheduled");
  });

  it("sends a scheduled campaign once its instant has arrived", async () => {
    // Insert a due scheduled row directly (1s past due — inside the early-fire
    // tolerance on the "proceed" side).
    const [row] = await db
      .insert(campaigns)
      .values({
        name: "Due now",
        status: "scheduled",
        audienceKind: "list",
        audienceId: "broadcast",
        templateKey: "welcome",
        props: { name: "Ada" },
        scheduledAt: new Date(Date.now() - 1000),
      })
      .returning({ id: campaigns.id });
    expect(row).toBeDefined();
    const campaignId = (row as { id: string }).id;

    providerSend.mockClear();
    const result = await campaignTask.fn({ campaignId });
    expect(result.status).toBe("sent");
    expect(result.sentCount).toBe(1); // the one subscribed member

    const [after] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    expect(after?.status).toBe("sent");
    expect(after?.completedAt).toBeTruthy();
  });
});

// ===========================================================================
// (12) Reaper: due `scheduled` rows are promoted (enqueue-only); rows stuck
//      past the give-up window (measured from scheduledAt) are failed
// ===========================================================================

describe("reapStuckCampaignsTask (scheduled sweeps)", () => {
  const reaperTask = reapStuckCampaignsTask as unknown as {
    fn: () => Promise<{
      failed: number;
      reEnqueued: number;
      promoted: number;
    }>;
  };

  it("promotes a due scheduled campaign and fails one past the give-up window", async () => {
    const inserted = await db
      .insert(campaigns)
      .values([
        {
          name: "Due, punctual run never fired",
          status: "scheduled",
          audienceKind: "list",
          audienceId: "broadcast",
          templateKey: "welcome",
          scheduledAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min past
        },
        {
          name: "Stuck past give-up",
          status: "scheduled",
          audienceKind: "list",
          audienceId: "broadcast",
          templateKey: "welcome",
          scheduledAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h past
        },
      ])
      .returning({ id: campaigns.id });
    const dueId = inserted[0]?.id as string;
    const stuckId = inserted[1]?.id as string;

    runNoWaitSpy.mockClear();
    await reaperTask.fn();

    // The due row was promoted — enqueue-only, so it stays `scheduled` until
    // the send task claims it.
    const promotedIds = runNoWaitSpy.mock.calls.map(
      (call) => (call[0] as { campaignId: string }).campaignId,
    );
    expect(promotedIds).toContain(dueId);
    const [dueRow] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, dueId));
    expect(dueRow?.status).toBe("scheduled");

    // The 7h-stale row was declared failed (from scheduledAt, NOT updatedAt —
    // its updatedAt is fresh from the insert just now).
    const [stuckRow] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, stuckId));
    expect(stuckRow?.status).toBe("failed");
    expect(promotedIds).not.toContain(stuckId);
  });

  it("leaves a future scheduled campaign alone", async () => {
    const inserted = await db
      .insert(campaigns)
      .values({
        name: "Future — not the reaper's business",
        status: "scheduled",
        audienceKind: "list",
        audienceId: "broadcast",
        templateKey: "welcome",
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: campaigns.id });
    const futureId = inserted[0]?.id as string;

    runNoWaitSpy.mockClear();
    await reaperTask.fn();

    const promotedIds = runNoWaitSpy.mock.calls.map(
      (call) => (call[0] as { campaignId: string }).campaignId,
    );
    expect(promotedIds).not.toContain(futureId);
    const [row] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, futureId));
    expect(row?.status).toBe("scheduled");
  });
});
