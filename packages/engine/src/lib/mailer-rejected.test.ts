import assert from "node:assert/strict";
import test from "node:test";
import type { EmailEvent, EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type { TemplateRegistry } from "@hogsend/email";

// mailer's import chain reaches env.ts (validates required env vars at import
// time) and lib/hatchet.ts (parses HATCHET_CLIENT_TOKEN as a JWT at import
// time) — stub both BEFORE the dynamic import. Nothing is ever contacted: the
// db is a recorder and the provider is never called on this path.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
const { createTrackedMailer } = await import("./mailer.js");

/**
 * `email.rejected` handling (PRD 18).
 *
 * SES accepted the message, returned a message id, and then threw it away
 * because it detected a virus. Two things have to be true of that, and the
 * second one is the reason this file exists:
 *
 *  1. the send reaches a TERMINAL status — no further event is coming, so a row
 *     left at `sent` stays non-terminal permanently;
 *  2. **NOTHING is suppressed.** The recipient's address is fine; our content
 *     was the problem. Folding a reject onto the bounce path would let one bad
 *     attachment permanently block a deliverable address, silently, with the
 *     customer discovering it months later.
 *
 * Asserted at the DB seam with a recording fake, so the assertion is about the
 * statements the mailer actually issues rather than about a mock's call count.
 * The reject deliberately NAMES a recipient (the normalizer sends
 * `mail.destination`, because a reject is message-scoped): a no-suppression
 * test over an empty recipient list would pass whatever the code did.
 */

interface RecordedUpdate {
  table: unknown;
  values: Record<string, unknown>;
}

function recordingDb(): { db: Database; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];
  const db = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          updates.push({ table, values });
          return { where: () => Promise.resolve([]) };
        },
      };
    },
  };
  return { db: db as unknown as Database, updates };
}

/** Never called on the webhook path — present only to satisfy the contract. */
const provider = {
  meta: { id: "test", name: "Test" },
  capabilities: { nativeTracking: false },
  send: async () => ({ id: "unused" }),
} as unknown as EmailProvider;

function mailer(db: Database) {
  return createTrackedMailer(
    {
      defaultFrom: "test@example.com",
      templates: {} as TemplateRegistry,
      db,
    },
    { provider },
  );
}

function rejected(overrides: Partial<EmailEvent> = {}): EmailEvent {
  return {
    type: "email.rejected",
    messageId: "0100018f-ses-rejected-id",
    recipients: ["good-address@example.com"],
    occurredAt: new Date().toISOString(),
    reject: { reason: "Bad content" },
    raw: {},
    ...overrides,
  };
}

test("email.rejected marks the send TERMINAL", async () => {
  const { db, updates } = recordingDb();
  const result = await mailer(db).handleWebhook(rejected());

  assert.equal(result.type, "email.rejected");

  const sendUpdates = updates.filter((row) => row.table === emailSends);
  assert.equal(sendUpdates.length, 1);
  // `failed` is the terminal status this schema already has for "did not reach
  // the recipient and nothing further is coming". It is NOT `bounced`: that
  // status carries a bounce classification the engine suppresses on.
  assert.equal(sendUpdates[0]?.values.status, "failed");
});

test("email.rejected records no bounce facts on the send row", async () => {
  const { db, updates } = recordingDb();
  await mailer(db).handleWebhook(rejected());

  const values = updates.find((row) => row.table === emailSends)?.values ?? {};
  assert.equal("bouncedAt" in values, false);
  assert.equal("bounceType" in values, false);
  assert.equal("bounceReason" in values, false);
  // A reject never arrived, so it must not read as a delivery either.
  assert.equal("deliveredAt" in values, false);
});

test("email.rejected SUPPRESSES NOTHING, even naming a recipient", async () => {
  // THE assertion of this PRD. `email_preferences` is the only table
  // suppression and the bounce counter live in, so ZERO writes to it is the
  // whole claim: no `bounceCount` increment, no `suppressed` flag, nothing to
  // undo later.
  const { db, updates } = recordingDb();
  await mailer(db).handleWebhook(rejected());

  const preferenceUpdates = updates.filter(
    (row) => row.table === emailPreferences,
  );
  assert.deepEqual(preferenceUpdates, []);
});

test("a reject carrying a bounce block STILL suppresses nothing", async () => {
  // Defence in depth. The plugin already strips `bounce` off a reject, so this
  // is what happens if a future provider (or a hand-built event) does not: the
  // engine branches on the TYPE, never on the presence of the block.
  const { db, updates } = recordingDb();
  await mailer(db).handleWebhook(
    rejected({ bounce: { class: "permanent", code: "Permanent/General" } }),
  );

  assert.deepEqual(
    updates.filter((row) => row.table === emailPreferences),
    [],
  );
});

test("a permanent bounce DOES suppress — the mutation check's control", async () => {
  // The counterweight. Without this, "no preference writes" could pass because
  // the recording db never sees preference writes at all, and the
  // no-suppression test above would be vacuous.
  const { db, updates } = recordingDb();
  await mailer(db).handleWebhook({
    type: "email.bounced",
    messageId: "0100018f-ses-bounced-id",
    recipients: ["good-address@example.com"],
    occurredAt: new Date().toISOString(),
    bounce: { class: "permanent", code: "Permanent/General" },
    raw: {},
  });

  const preferenceUpdates = updates.filter(
    (row) => row.table === emailPreferences,
  );
  assert.equal(preferenceUpdates.length, 1);
  assert.ok("bounceCount" in (preferenceUpdates[0]?.values ?? {}));
});

test("a consumer handler for email.rejected is invoked with the reason", async () => {
  // How a journey learns the send is never arriving: the neutral type gets a
  // `WebhookHandlerMap` slot for free, and the reason rides verbatim.
  const { db } = recordingDb();
  const seen: EmailEvent[] = [];
  const service = createTrackedMailer(
    {
      defaultFrom: "test@example.com",
      templates: {} as TemplateRegistry,
      db,
      webhookHandlers: {
        "email.rejected": (event) => {
          seen.push(event);
        },
      },
    },
    { provider },
  );

  const result = await service.handleWebhook(rejected());

  assert.equal(result.handled, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.reject, { reason: "Bad content" });
});

test("a provider that never emits email.rejected behaves exactly as today", async () => {
  // The back-compat line: adding a union member must not change any existing
  // branch. A delivery still writes `delivered` + `deliveredAt` and touches no
  // preference row.
  const { db, updates } = recordingDb();
  await mailer(db).handleWebhook({
    type: "email.delivered",
    messageId: "0100018f-ses-delivered-id",
    recipients: ["good-address@example.com"],
    occurredAt: new Date().toISOString(),
    raw: {},
  });

  const values = updates.find((row) => row.table === emailSends)?.values ?? {};
  assert.equal(values.status, "delivered");
  assert.ok(values.deliveredAt instanceof Date);
  assert.deepEqual(
    updates.filter((row) => row.table === emailPreferences),
    [],
  );
});
