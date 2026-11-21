/**
 * An open/click on a journeyless send must not hand the recipient ADDRESS to
 * the resolver as an external `userId`.
 *
 * `resolveEmailSendContext` used to fall back `userId: journeyStates.userId ??
 * toEmail`, ignoring `email_sends.user_id` (which the messageId twin already
 * honoured). For a raw send to an email-only contact that re-ingested the open
 * as `{ userId: <address>, userEmail: <address> }`; the resolver matched the
 * contact by email and filled its free `external_id` column with the address,
 * flipping the contact's canonical key to a string that is not an app id.
 *
 * What must NOT regress: the open still stores and still lands on the same
 * contact.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, emailSends, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  pushTrackingEvent,
  resolveEmailSendContext,
  resolveEmailSendContextByMessageId,
} = await import("@hogsend/engine");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db, logger, registry } = container;

const RUN = `trsi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const EMAIL = `${RUN}@example.test`;
const contactIds: string[] = [];
const sendIds: string[] = [];

afterAll(async () => {
  if (sendIds.length) {
    await db.delete(emailSends).where(inArray(emailSends.id, sendIds));
  }
  if (contactIds.length) {
    await db
      .delete(userEvents)
      .where(inArray(userEvents.contactId, contactIds));
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  await db.delete(userEvents).where(eq(userEvents.userId, EMAIL));
});

async function rawSend(opts: { userId?: string; messageId?: string }) {
  const [row] = await db
    .insert(emailSends)
    .values({
      fromEmail: "from@example.test",
      toEmail: EMAIL,
      subject: "raw",
      status: "sent",
      userId: opts.userId ?? null,
      messageId: opts.messageId ?? null,
    })
    .returning({ id: emailSends.id });
  if (!row) throw new Error("send insert failed");
  sendIds.push(row.id);
  return row.id;
}

it("an open on a raw send leaves an email-only contact's external_id empty", async () => {
  const [contact] = await db
    .insert(contacts)
    .values({ email: EMAIL })
    .returning({ id: contacts.id });
  if (!contact) throw new Error("contact insert failed");
  contactIds.push(contact.id);

  const sendId = await rawSend({});
  const result = await pushTrackingEvent({
    db,
    hatchet: container.hatchet,
    registry,
    logger,
    event: "email.opened",
    emailSendId: sendId,
  });

  expect(result?.stored).toBe(true);
  const [after] = await db
    .select({ externalId: contacts.externalId, email: contacts.email })
    .from(contacts)
    .where(eq(contacts.id, contact.id));
  expect(after?.externalId).toBeNull();
  expect(after?.email).toBe(EMAIL);

  const stored = await db
    .select({ contactId: userEvents.contactId })
    .from(userEvents)
    .where(eq(userEvents.contactId, contact.id));
  expect(stored.length).toBe(1);
});

it("both send-context resolvers honour email_sends.user_id", async () => {
  const messageId = `${RUN}-msg`;
  const sendId = await rawSend({ userId: `${RUN}-app-user`, messageId });

  const byId = await resolveEmailSendContext(db, sendId);
  const byMessage = await resolveEmailSendContextByMessageId(db, messageId);
  expect(byId?.userId).toBe(`${RUN}-app-user`);
  expect(byMessage?.userId).toBe(`${RUN}-app-user`);
});
