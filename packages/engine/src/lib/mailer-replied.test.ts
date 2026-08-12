import assert from "node:assert/strict";
import test from "node:test";
import type { EmailEvent, EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends, webhookDeliveries } from "@hogsend/db";
import type { TemplateRegistry } from "@hogsend/email";

// mailer's import chain reaches env.ts (validates required env vars at import
// time) and lib/hatchet.ts (parses HATCHET_CLIENT_TOKEN as a JWT at import
// time) — stub both BEFORE the dynamic import. Nothing is ever contacted: the
// db is a recorder, the provider is never called on this path, and the bus push
// is injected.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
const { createTrackedMailer } = await import("./mailer.js");

/**
 * `email.replied` handling (PRD 16 task 5).
 *
 * The feature exists for ONE reason, stated in the PRD: "so a JOURNEY can know
 * a human replied, and stop." Without it a contact answers "please stop
 * emailing me" and the sequence sends three more. So the two claims asserted
 * here are the two halves of that:
 *
 *  1. the reply reaches the INTERNAL bus under the name a journey waits on,
 *     carrying the in-reply-to id, the sender and the text — the EARS list;
 *  2. the reply reaches the OUTBOUND spine, correlated or not.
 *
 * And the two things it must NOT do, both of which are silent when broken:
 *
 *  - **no status write.** A reply is not a delivery outcome. A message that was
 *    delivered and then answered is still delivered, and writing a status here
 *    would overwrite that with something no send ever had;
 *  - **no suppression.** Somebody replying is the strongest possible evidence
 *    the address works. `email_preferences` is where suppression lives, so zero
 *    writes to it is the claim.
 *
 * Asserted at the DB seam with a recording fake, so the assertions are about
 * statements the mailer actually issues rather than about a mock's call count.
 */

interface RecordedUpdate {
  table: unknown;
  values: Record<string, unknown>;
}

interface RecordedInsert {
  table: unknown;
  values: unknown;
}

interface SendRow {
  emailSendId: string;
  toEmail: string;
  templateKey: string | null;
  sendContactId: string | null;
  userId: string | null;
  userEmail: string | null;
  enrollmentContactId: string | null;
  sendUserId: string | null;
  sendUserEmail: string | null;
}

/**
 * A db that answers the ONE read this path makes (`email_sends` by provider
 * message id) and records every write.
 *
 * `selectRows` is what the message-id lookup returns: `[]` models a reply that
 * correlates to nothing, which is the uncorrelated case the EARS names.
 */
/**
 * A resolved statement that also answers `.returning()`, like drizzle's
 * builder. The bounce leg claims its send with a guarded `UPDATE ... RETURNING`
 * (see `claimBounce`), so the recorder has to model the row it matched: one
 * row = "a real send that had not bounced yet", which is what the bounce
 * control below assumes.
 */
function settled(): Promise<{ id: string }[]> & {
  returning: () => Promise<{ id: string }[]>;
} {
  const rows = [{ id: "send-row-uuid" }];
  const promise = Promise.resolve(rows) as Promise<{ id: string }[]> & {
    returning: () => Promise<{ id: string }[]>;
  };
  promise.returning = () => Promise.resolve(rows);
  return promise;
}

function recordingDb(selectRows: SendRow[] = []): {
  db: Database;
  updates: RecordedUpdate[];
  inserts: RecordedInsert[];
} {
  const updates: RecordedUpdate[] = [];
  const inserts: RecordedInsert[] = [];
  const db = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table, values });
          return { where: () => settled() };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          inserts.push({ table, values });
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([]),
            }),
            returning: () => Promise.resolve([]),
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            // `resolveEmailSendContextByMessageId` JOINS to `journey_states`;
            // `emitOutbound`'s subscribed-endpoint select does not. The two
            // shapes are told apart by that join, so one recorder can serve
            // both reads without either answering the other's question.
            leftJoin: () => ({
              where: () => ({ limit: () => Promise.resolve(selectRows) }),
            }),
            // One subscribed endpoint, so the spine has somewhere to deliver.
            where: () => Promise.resolve([{ id: "endpoint-1" }]),
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates, inserts };
}

/** Never called on the webhook path — present only to satisfy the contract. */
const provider = {
  meta: { id: "test", name: "Test" },
  capabilities: { nativeTracking: false },
  send: async () => ({ id: "unused" }),
} as unknown as EmailProvider;

interface PushedEvent {
  event: string;
  emailSendId: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

function mailer(db: Database, pushed: PushedEvent[] = []) {
  return createTrackedMailer(
    { defaultFrom: "test@example.com", templates: {} as TemplateRegistry, db },
    {
      provider,
      // The bus push is the one seam injected here: the real one reaches
      // `ingestEvent`, which resolves identity and pushes to Hatchet. What this
      // file is asserting is WHAT the mailer hands the bus, not what the bus
      // then does with it.
      pushReplyEvent: async (opts) => {
        pushed.push({
          event: opts.event,
          emailSendId: opts.emailSendId,
          ...(opts.properties ? { properties: opts.properties } : {}),
          ...(opts.idempotencyKey
            ? { idempotencyKey: opts.idempotencyKey }
            : {}),
        });
        return undefined;
      },
    },
  );
}

const SEND: SendRow = {
  emailSendId: "send-row-uuid",
  toEmail: "contact@example.com",
  templateKey: "onboarding-day-1",
  sendContactId: null,
  userId: "user_42",
  userEmail: "contact@example.com",
  enrollmentContactId: null,
  sendUserId: null,
  sendUserEmail: null,
};

function replied(overrides: Partial<EmailEvent> = {}): EmailEvent {
  return {
    type: "email.replied",
    messageId: "0100019-the-received-reply",
    recipients: ["hello@reply.acme.test"],
    occurredAt: new Date().toISOString(),
    reply: {
      recipient: "hello@reply.acme.test",
      from: "human@sender.test",
      subject: "Re: your onboarding email",
      text: "Please stop emailing me.",
      textTruncated: false,
      correlated: true,
      inReplyTo: "0100018f-the-original-send",
    },
    raw: {},
    ...overrides,
  };
}

test("a correlated reply reaches the bus under the name a journey waits on", async () => {
  const { db } = recordingDb([SEND]);
  const pushed: PushedEvent[] = [];
  const result = await mailer(db, pushed).handleWebhook(replied());

  assert.equal(result.type, "email.replied");
  assert.equal(pushed.length, 1);
  // The EXACT string the PRD promises a journey can wait on. A second spelling
  // here would make `ctx.waitForEvent({ event: "email.replied" })` silently
  // never fire.
  assert.equal(pushed[0]?.event, "email.replied");
  assert.equal(pushed[0]?.emailSendId, "send-row-uuid");
});

test("the bus event carries the in-reply-to id, the sender and the text", async () => {
  // The EARS list, verbatim: "SHALL emit `email.replied` with the in-reply-to
  // id, the sender, and a text body". Each of the three is what a journey
  // branches on, so each is asserted by name rather than by shape.
  const { db } = recordingDb([SEND]);
  const pushed: PushedEvent[] = [];
  await mailer(db, pushed).handleWebhook(replied());

  const properties = pushed[0]?.properties ?? {};
  assert.equal(properties.inReplyTo, "0100018f-the-original-send");
  assert.equal(properties.from, "human@sender.test");
  assert.equal(properties.text, "Please stop emailing me.");
  assert.equal(properties.correlated, true);
  assert.equal(properties.messageId, "0100019-the-received-reply");
});

test("a redelivered reply carries the SAME idempotency key", async () => {
  // SNS is at-least-once and the relay re-drives a failed instance hop, so the
  // same reply can arrive twice. A duplicate `email.replied` on the bus can
  // exit a journey a second time, and an exit is not a thing that can be taken
  // back — the key is what collapses the pair, and it is derived from the
  // RECEIVED message's id, which is stable across every redelivery.
  const { db } = recordingDb([SEND]);
  const pushed: PushedEvent[] = [];
  const service = mailer(db, pushed);
  await service.handleWebhook(replied());
  await service.handleWebhook(replied());

  assert.equal(pushed.length, 2);
  assert.equal(pushed[0]?.idempotencyKey, pushed[1]?.idempotencyKey);
  assert.match(String(pushed[0]?.idempotencyKey), /0100019-the-received-reply/);
});

test("an UNCORRELATED reply is still delivered, and marked uncorrelated", async () => {
  // The EARS: "WHEN a reply cannot be correlated to an `email_sends` row, the
  // system SHALL still store and deliver it, and SHALL mark it uncorrelated."
  // There is no contact key to ingest against, so the bus is skipped — but the
  // spine is NOT, because a human still replied and dropping their words to
  // keep a payload tidy is the worse failure.
  const { db, inserts } = recordingDb([]);
  const pushed: PushedEvent[] = [];
  await mailer(db, pushed).handleWebhook(
    replied({
      reply: {
        recipient: "hello@reply.acme.test",
        from: "stranger@elsewhere.test",
        subject: "hello",
        text: "who is this",
        textTruncated: false,
        correlated: false,
      },
    }),
  );

  assert.deepEqual(pushed, []);

  const delivery = inserts.find((row) => row.table === webhookDeliveries);
  assert.ok(delivery, "an uncorrelated reply must still reach the spine");
  const payload = (
    delivery.values as { payload: { data: Record<string, unknown> } }[]
  )[0]?.payload;
  assert.equal(payload?.data.correlated, false);
  assert.equal(payload?.data.inReplyTo, null);
  assert.equal(payload?.data.emailSendId, null);
  assert.equal(payload?.data.from, "stranger@elsewhere.test");
});

test("a correlated reply reaches the spine with its send context", async () => {
  const { db, inserts } = recordingDb([SEND]);
  await mailer(db).handleWebhook(replied());

  const delivery = inserts.find((row) => row.table === webhookDeliveries);
  assert.ok(delivery, "a correlated reply must reach the spine");
  const rows = delivery.values as {
    eventType: string;
    dedupeKey: string | null;
    payload: { data: Record<string, unknown> };
  }[];
  assert.equal(rows[0]?.eventType, "email.replied");
  // The spine's own dedupe, for the same at-least-once reason as the bus key.
  assert.match(String(rows[0]?.dedupeKey), /0100019-the-received-reply/);
  assert.equal(rows[0]?.payload.data.emailSendId, "send-row-uuid");
  assert.equal(rows[0]?.payload.data.userId, "user_42");
  assert.equal(rows[0]?.payload.data.templateKey, "onboarding-day-1");
});

test("a reply writes NO status onto the send it answers", async () => {
  // A reply is not a delivery outcome. The send it answers was delivered and
  // stays delivered; writing a status here would overwrite a real outcome with
  // one no send ever had, and every bounce-rate and delivery read would then
  // count it.
  const { db, updates } = recordingDb([SEND]);
  await mailer(db).handleWebhook(replied());

  assert.deepEqual(
    updates.filter((row) => row.table === emailSends),
    [],
  );
});

test("a reply SUPPRESSES NOTHING", async () => {
  // Somebody replying is the strongest evidence an address works.
  // `email_preferences` is the only table suppression and the bounce counter
  // live in, so zero writes to it is the whole claim.
  const { db, updates } = recordingDb([SEND]);
  await mailer(db).handleWebhook(replied());

  assert.deepEqual(
    updates.filter((row) => row.table === emailPreferences),
    [],
  );
});

test("a permanent bounce still writes both — the mutation check's control", async () => {
  // The counterweight. Without it, the two "writes nothing" tests above could
  // pass because the recording db never sees any write at all.
  const { db, updates } = recordingDb([SEND]);
  await mailer(db).handleWebhook({
    type: "email.bounced",
    messageId: "0100018f-ses-bounced-id",
    recipients: ["good-address@example.com"],
    occurredAt: new Date().toISOString(),
    bounce: { class: "permanent", code: "Permanent/General" },
    raw: {},
  });

  assert.equal(updates.filter((row) => row.table === emailSends).length, 1);
  assert.equal(
    updates.filter((row) => row.table === emailPreferences).length,
    1,
  );
});

test("a consumer handler for email.replied receives the reply detail", async () => {
  const { db } = recordingDb([SEND]);
  const seen: EmailEvent[] = [];
  const service = createTrackedMailer(
    {
      defaultFrom: "test@example.com",
      templates: {} as TemplateRegistry,
      db,
      webhookHandlers: {
        "email.replied": (event) => {
          seen.push(event);
        },
      },
    },
    { provider, pushReplyEvent: async () => undefined },
  );

  const result = await service.handleWebhook(replied());

  assert.equal(result.handled, true);
  assert.equal(seen[0]?.reply?.from, "human@sender.test");
});
