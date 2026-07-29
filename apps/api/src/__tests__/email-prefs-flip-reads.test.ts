/**
 * PRD 05 T6 — email preference reads follow the CONTACT, not the string key.
 *
 * The unsubscribe ledger (`email_preferences`) is written under whatever
 * canonical key the subject had at opt-out time. After T9 removes the
 * string-rewrite machinery, that `user_id` is a frozen historical value — so
 * every read that gates a send MUST reach the row through `contact_id`
 * (stamped by adoption/backfill) rather than the mutable string key.
 *
 * Fixture laws (shared with journey-flip-reads.test.ts):
 *  - every key is run-namespaced (`t6flip-<uuid>-...`) — suites may run
 *    concurrently against one database; never count whole tables.
 *  - divergent-key rows are stamped with the D4 adoption statement
 *    (`UPDATE ... SET contact_id = :id WHERE user_id = :stale AND contact_id
 *    IS NULL`) — NEVER via resolveOrCreateContact, whose adoption path also
 *    rewrites `user_id` today and would make these tests vacuously green.
 *
 * The three probes:
 *  (a) regression — unsubscribe under the anon era key, register, send to the
 *      SAME address: suppressed (the email leg already covers this today).
 *  (b) the red proof — unsubscribe recorded under a stale key AND an old
 *      address; the contact later carries a NEW address. A marketing send to
 *      the new address must still be suppressed: only the contact-scoped read
 *      can see the opt-out (no string leg, no email leg matches).
 *  (c) reader-level — readRecipientPreferences finds the opt-out through
 *      `contactId` when the string key has diverged.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Same default as every suite in this directory: the CI service container.
// Point a worktree at its own stack via HOGSEND_TEST_DATABASE_URL.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The mailer's outbound emits ride the Hatchet singleton; keep it inert.
const hatchetMock = () => ({
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
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, emailPreferences, emailSends } = await import("@hogsend/db");
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const {
  createHogsendClient,
  createTrackedMailer,
  readRecipientPreferences,
  resolveOrCreateContact,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `t6flip-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

// (a) — same address across the transition.
const A_STALE = uid("a-stale");
const A_USER = uid("a-user");
const A_EMAIL = `${uid("a")}@example.test`;

// (b) — address changed after the opt-out.
const B_STALE = uid("b-stale");
const B_USER = uid("b-user");
const B_OLD_EMAIL = `${uid("b-old")}@example.test`;
const B_NEW_EMAIL = `${uid("b-new")}@example.test`;

// (c) — reader-level divergence.
const C_STALE = uid("c-stale");
const C_USER = uid("c-user");
const C_EMAIL = `${uid("c")}@example.test`;

const createdContactIds: string[] = [];

afterAll(async () => {
  await db
    .delete(emailSends)
    .where(inArray(emailSends.toEmail, [A_EMAIL, B_NEW_EMAIL, B_OLD_EMAIL]));
  await db
    .delete(emailPreferences)
    .where(inArray(emailPreferences.userId, [A_STALE, B_STALE, C_STALE]));
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

const providerSend = vi.fn(async (_opts: { to: string | string[] }) => ({
  id: `prov-${randomUUID()}`,
}));
const fakeProvider: EmailProvider = {
  meta: { id: "resend", name: "t6-flip-test" },
  capabilities: { nativeTracking: false },
  send: providerSend,
  sendBatch: vi.fn(async () => ({ results: [] })),
  verifyWebhook: vi.fn(() => {
    throw new Error("unused");
  }),
  parseWebhook: vi.fn(() => {
    throw new Error("unused");
  }),
};

const mailer = createTrackedMailer(
  {
    defaultFrom: "Hogsend <noreply@hogsend.com>",
    // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
    db: db as any,
    templates,
  },
  { provider: fakeProvider },
);

/** D4's adoption statement verbatim: stamp ownership, do NOT touch user_id. */
async function stampPreference(staleKey: string, contactId: string) {
  await db
    .update(emailPreferences)
    .set({ contactId })
    .where(
      and(
        eq(emailPreferences.userId, staleKey),
        isNull(emailPreferences.contactId),
      ),
    );
}

describe("T6 — unsubscribe follows the CONTACT across key divergence", () => {
  it("(a) regression: same-address opt-out under the adopted key still suppresses", async () => {
    await db.insert(emailPreferences).values({
      userId: A_STALE,
      email: A_EMAIL,
      unsubscribedAll: true,
    });
    const contact = await resolveOrCreateContact({
      db,
      userId: A_USER,
      email: A_EMAIL,
    });
    createdContactIds.push(contact.id);
    await stampPreference(A_STALE, contact.id);

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Ada" },
      to: A_EMAIL,
      userId: A_USER,
      subject: "T6 flip (a)",
    });

    expect(result.status).toBe("unsubscribed");
    expect(providerSend).not.toHaveBeenCalled();
  });

  it("(b) suppresses a send to the contact's NEW address when the opt-out row carries only the stale key and old address", async () => {
    await db.insert(emailPreferences).values({
      userId: B_STALE,
      email: B_OLD_EMAIL,
      unsubscribedAll: true,
    });
    const contact = await resolveOrCreateContact({
      db,
      userId: B_USER,
      email: B_NEW_EMAIL,
    });
    createdContactIds.push(contact.id);
    await stampPreference(B_STALE, contact.id);

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Ada" },
      to: B_NEW_EMAIL,
      userId: B_USER,
      subject: "T6 flip (b)",
    });

    // Neither the address leg (row holds the OLD email) nor a string-key read
    // (row holds the STALE key) can see this opt-out. Only contact_id can.
    expect(result.status).toBe("unsubscribed");
    expect(providerSend).not.toHaveBeenCalled();

    const [row] = await db
      .select({ status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.toEmail, B_NEW_EMAIL));
    expect(row?.status).toBe("suppressed");
  });

  it("(c) readRecipientPreferences reaches a diverged-key row through contactId", async () => {
    await db.insert(emailPreferences).values({
      userId: C_STALE,
      email: C_EMAIL,
      unsubscribedAll: true,
    });
    const contact = await resolveOrCreateContact({ db, userId: C_USER });
    createdContactIds.push(contact.id);
    await stampPreference(C_STALE, contact.id);

    const prefs = await readRecipientPreferences(db, {
      userId: C_USER,
      contactId: contact.id,
    });
    expect(prefs.unsubscribedAll).toBe(true);
  });
});
