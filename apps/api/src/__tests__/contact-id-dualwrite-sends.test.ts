/**
 * PRD 04 T4d — `email_sends.contact_id` dual-write.
 *
 * `sendTracked` resolves ONCE near the top and reuses that value at ALL THREE
 * insert sites (suppressed, test-mode-blocked, real). The load-bearing rule is
 * D7: the resolve is keyed on `options.userId` ONLY. A raw send carries no
 * userId, so it stamps NULL **even when `to_email` matches a real contact** —
 * resolving by address would make that send visible to per-contact queries that
 * cannot see it today, which is a read-shape change smuggled in through a write.
 *
 * The REAL `sendTrackedEmail` runs against the REAL database (only the provider
 * is a double — nothing may leave the machine), and every assertion reads the
 * `email_sends` row back.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { hatchetMock } = vi.hoisted(() => {
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
        runNoWait: vi.fn(),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

// PARTIAL mock of the engine's contacts module — everything real except
// `lookupContactIdByKey`, which is the real implementation wrapped in a spy.
// That is the D6 fault-injection seam; every other test in this file is
// unaffected because the spy delegates. Dual `.ts`/`.js` registration mirrors
// the hatchet idiom (the engine's own relative imports are `.js`-suffixed).
const { lookupSpy, contactsMock } = vi.hoisted(() => {
  const lookupSpy = vi.fn();
  const contactsMock = async (
    importOriginal: () => Promise<Record<string, unknown>>,
  ) => {
    const actual = await importOriginal();
    lookupSpy.mockImplementation(
      actual.lookupContactIdByKey as (...a: unknown[]) => unknown,
    );
    return { ...actual, lookupContactIdByKey: lookupSpy };
  };
  return { lookupSpy, contactsMock };
});
vi.mock("../../../../packages/engine/src/lib/contacts.ts", contactsMock);
vi.mock("../../../../packages/engine/src/lib/contacts.js", contactsMock);

const { contacts, emailPreferences, emailSends } = await import("@hogsend/db");
const { eq, like, or } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  resolveOrCreateContact,
  sendTrackedEmail,
} = await import("@hogsend/engine");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const RUN = `cisd-${randomUUID().slice(0, 8)}-${Date.now()}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

/** A provider double — the only thing stubbed; the pipeline above it is real. */
function makeProvider() {
  const send = vi.fn().mockResolvedValue({ id: `msg-${RUN}` });
  // biome-ignore lint/suspicious/noExplicitAny: only `send` is exercised
  return { send } as any;
}

/** Test mode ACTIVE but with no redirect inbox ⇒ the blocked-insert branch. */
const UNADDRESSABLE_TEST_MODE = {
  active: true,
  reason: "env_flag" as const,
  redirectTo: null,
  fromOverride: null,
};

const sendsTo = (toEmail: string) =>
  db.select().from(emailSends).where(eq(emailSends.toEmail, toEmail));

afterAll(async () => {
  await db
    .delete(emailSends)
    .where(
      or(
        like(emailSends.toEmail, `${RUN}-%`),
        like(emailSends.userId, `${RUN}-%`),
      ),
    );
  await db
    .delete(emailPreferences)
    .where(
      or(
        like(emailPreferences.email, `${RUN}-%`),
        like(emailPreferences.userId, `${RUN}-%`),
      ),
    );
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
      ),
    );
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("T4d — email_sends.contact_id, the three insert sites", () => {
  it("test-mode-blocked insert: stamped from options.userId", async () => {
    const userId = uid("blocked");
    const to = mail("blocked");
    const contact = await resolveOrCreateContact({ db, userId });

    const result = await sendTrackedEmail({
      db,
      provider: makeProvider(),
      registry: templates,
      testMode: UNADDRESSABLE_TEST_MODE,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        userId,
      },
    });
    expect(result.reason).toBe("test_mode_blocked");

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("suppressed insert: stamped from options.userId", async () => {
    const userId = uid("suppressed");
    const to = mail("suppressed");
    const contact = await resolveOrCreateContact({ db, userId });
    // A genuine full unsubscribe for this address ⇒ checkSuppression fires.
    await db
      .insert(emailPreferences)
      .values({ userId, email: to, unsubscribedAll: true });

    const provider = makeProvider();
    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        userId,
      },
    });
    expect(result.status).toBe("unsubscribed");
    expect(provider.send).not.toHaveBeenCalled();

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("real insert: stamped from options.userId", async () => {
    const userId = uid("real");
    const to = mail("real");
    const contact = await resolveOrCreateContact({ db, userId });

    const provider = makeProvider();
    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        userId,
      },
    });
    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("resolves an ANONYMOUS-keyed userId too (alias/column-wide probe)", async () => {
    const anonKey = uid("anon-send");
    const to = mail("anon-send");
    const contact = await resolveOrCreateContact({ db, anonymousId: anonKey });

    await sendTrackedEmail({
      db,
      provider: makeProvider(),
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        userId: anonKey,
      },
    });

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });
});

describe("T4d / D7 — a userId-less raw send NEVER resolves by to_email", () => {
  it("stamps NULL even though the recipient address owns a live contact", async () => {
    const to = mail("d7-owner");
    // Seed the contact the banned email fallback WOULD have found.
    const contact = await resolveOrCreateContact({ db, email: to });
    expect(contact.id).toBeTruthy();

    const provider = makeProvider();
    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        // NO userId — a raw send (public /v1/emails, password reset, …).
      },
    });
    expect(result.status).toBe("sent");

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    // THE D7 ASSERTION. An `expect(...).toBe(contact.id)` here would mean the
    // send became visible to per-contact queries that cannot see it today.
    expect(rows[0]?.contactId).toBeNull();
  });

  it("stamps NULL even when the address IS a contact's external_id", async () => {
    // Email-as-external-id is common in the wild, so a `userId ?? to` fallback
    // WOULD resolve here through the ordinary external_id leg. This case pins
    // the absence of that fallback independently of how the probe is written.
    const to = mail("d7-ext-key");
    const contact = await resolveOrCreateContact({ db, userId: to });
    expect(contact.resolvedKey).toBe(to);

    await sendTrackedEmail({
      db,
      provider: makeProvider(),
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        // Still NO userId — the send has asserted no identity.
      },
    });

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
  });
});

describe("T4d — the admin resend COPIES the source row's contact_id", () => {
  /** Seed a resendable (`failed`) source row and return its id. */
  async function seedFailedSend(opts: {
    to: string;
    userId?: string;
    contactId?: string | null;
  }): Promise<string> {
    const [row] = await db
      .insert(emailSends)
      .values({
        templateKey: "welcome",
        fromEmail: mail("from"),
        toEmail: opts.to,
        subject: `${RUN} resend source`,
        category: "transactional",
        userId: opts.userId,
        userEmail: opts.to,
        status: "failed",
        contactId: opts.contactId ?? null,
      })
      .returning({ id: emailSends.id });
    if (!row) throw new Error("failed to seed source send");
    return row.id;
  }

  const resend = (id: string) =>
    app.request(`/v1/admin/emails/${id}/resend`, {
      method: "POST",
      headers: AUTH_HEADER,
    });

  it("a stamped source produces a stamped resend row", async () => {
    const userId = uid("resend");
    const to = mail("resend");
    const contact = await resolveOrCreateContact({ db, userId });
    const sourceId = await seedFailedSend({
      to,
      userId,
      contactId: contact.id,
    });

    const res = await resend(sourceId);
    expect(res.status).toBe(202);
    const { emailId } = (await res.json()) as { emailId: string };
    expect(emailId).not.toBe(sourceId);

    const [row] = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.id, emailId));
    expect(row?.status).toBe("queued");
    expect(row?.contactId).toBe(contact.id);
  });

  it("a NULL-stamped source resends NULL — the copy never RE-RESOLVES", async () => {
    // The source carries a real `userId` whose contact exists, so a resend that
    // re-derived the stamp instead of copying it would fill this in. Copying is
    // the contract: a resend must not silently gain a provenance the original
    // send did not have.
    const userId = uid("resend-null");
    const to = mail("resend-null");
    await resolveOrCreateContact({ db, userId });
    const sourceId = await seedFailedSend({ to, userId, contactId: null });

    const res = await resend(sourceId);
    expect(res.status).toBe(202);
    const { emailId } = (await res.json()) as { emailId: string };

    const [row] = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.id, emailId));
    expect(row?.contactId).toBeNull();
  });
});

describe("D6 — a throwing resolve never fails the send", () => {
  it("the send still goes out, with contact_id NULL", async () => {
    // A userId that DOES own a contact, so without the fault this row would be
    // stamped — the NULL below can only come from the swallowed rejection.
    const userId = uid("d6-send");
    const to = mail("d6-send");
    await resolveOrCreateContact({ db, userId });

    lookupSpy.mockRejectedValueOnce(new Error("injected: probe unavailable"));

    const provider = makeProvider();
    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      options: {
        templateKey: "welcome",
        props: { name: "Ada" },
        from: mail("from"),
        to,
        userId,
      },
    });

    // Kills the rethrow mutation: an unwrapped resolve would reject here.
    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);

    const rows = await sendsTo(to);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
  });

  it("the partial mock is LIVE (guards the test above from being vacuous)", () => {
    // If `vi.mock` had not intercepted the engine's own `./contacts.js`
    // specifier, the rejection above would have been injected into nothing.
    expect(lookupSpy).toHaveBeenCalled();
  });
});
