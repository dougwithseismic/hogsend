import assert from "node:assert/strict";
import test from "node:test";
import type { EmailEvent, EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends, webhookDeliveries } from "@hogsend/db";
import type { TemplateRegistry } from "@hogsend/email";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// mailer's import chain reaches env.ts (validates required env vars at import
// time) and lib/hatchet.ts (parses HATCHET_CLIENT_TOKEN as a JWT at import
// time) — stub both BEFORE the dynamic import. Nothing is ever contacted: the
// db is a fake and the provider is never called on this path.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
const { createTrackedMailer } = await import("./mailer.js");

/**
 * BOUNCE IDEMPOTENCY.
 *
 * SNS is at-least-once, and the control plane deliberately re-drives a
 * `pending` event row after 60s so a bounce is never LOST — which means the
 * SAME bounce can reach this instance more than once. Two things must survive
 * that, and neither is cosmetic:
 *
 *  1. **the suppression counter.** `bounceThreshold` defaults to 3, so THREE
 *     redeliveries of ONE bounce would permanently suppress a perfectly
 *     deliverable address — silently, with nothing the customer can undo;
 *  2. **the outbound `email.bounced` emit.** A redelivery double-fires the
 *     customer's webhook destination and fires a journey waiting on
 *     `email.bounced` twice.
 *
 * Asserted against a db fake that EVALUATES the statement's WHERE clause
 * against modelled row state (rendered through drizzle's own pg dialect)
 * rather than assuming a guard exists. That is the point: a fake that simply
 * refused the second write would pass whether or not the engine actually
 * guards, which is the vacuous-green trap this repo has been bitten by. Delete
 * the guard and these tests go red.
 */

const dialect = new PgDialect();

/** `bounced_at` → `bouncedAt`. */
function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Evaluate a rendered WHERE against a modelled row. Supports EXACTLY the three
 * predicate shapes this path emits and THROWS on anything else — an unknown
 * shape must fail loudly rather than silently evaluate to "matched".
 */
function matches(row: Record<string, unknown>, condition: unknown): boolean {
  const { sql: text, params } = dialect.sqlToQuery(condition as SQL);
  const terms = text.replace(/^\(/, "").replace(/\)$/, "").split(" and ");
  return terms.every((raw) => {
    const term = raw.trim();
    let m = /^"[a-z_]+"\."([a-z_]+)" = \$(\d+)$/.exec(term);
    if (m) return row[camel(m[1] as string)] === params[Number(m[2]) - 1];
    m = /^"[a-z_]+"\."([a-z_]+)" is null$/.exec(term);
    if (m) return row[camel(m[1] as string)] == null;
    m = /^"[a-z_]+"\."([a-z_]+)" is distinct from \$(\d+)$/.exec(term);
    if (m) return row[camel(m[1] as string)] !== params[Number(m[2]) - 1];
    throw new Error(`fake db: unsupported predicate \`${term}\``);
  });
}

interface FakeSend {
  id: string;
  messageId: string;
  toEmail: string;
  status: string;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
  bounceType: string | null;
  bounceReason: string | null;
}

function send(messageId: string, overrides: Partial<FakeSend> = {}): FakeSend {
  return {
    id: `send-${messageId}`,
    messageId,
    toEmail: "recipient@example.com",
    status: "sent",
    sentAt: new Date(),
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    bouncedAt: null,
    bounceType: null,
    bounceReason: null,
    ...overrides,
  };
}

interface RecordedUpdate {
  values: Record<string, unknown>;
  /** How many modelled rows the statement's WHERE actually matched. */
  matched: number;
}

interface FakeDb {
  db: Database;
  sends: FakeSend[];
  sendUpdates: RecordedUpdate[];
  preferenceUpdates: RecordedUpdate[];
  /** Advanced by 1 per issued `bounce_count + 1` statement. */
  bounceCount: () => number;
  outbound: () => { eventType: string }[];
  warnings: { message: string; meta?: unknown }[];
}

/** A resolved promise that also answers `.returning()`, like drizzle's builder. */
function settled<T>(
  rows: T[],
): Promise<T[]> & { returning: () => Promise<T[]> } {
  const promise = Promise.resolve(rows) as Promise<T[]> & {
    returning: () => Promise<T[]>;
  };
  promise.returning = () => Promise.resolve(rows);
  return promise;
}

function fakeDb(rows: FakeSend[]): FakeDb {
  const sendUpdates: RecordedUpdate[] = [];
  const preferenceUpdates: RecordedUpdate[] = [];
  const deliveries: { eventType: string }[] = [];
  const warnings: { message: string; meta?: unknown }[] = [];
  let bounceCount = 0;

  const db = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              if (table === emailSends) {
                const hit = rows.filter((row) =>
                  matches(row as unknown as Record<string, unknown>, condition),
                );
                for (const row of hit) {
                  for (const [key, value] of Object.entries(values)) {
                    // Drizzle `sql` expressions (the counter increments) are
                    // modelled separately; plain values write through.
                    if (
                      value &&
                      typeof value === "object" &&
                      "queryChunks" in value
                    ) {
                      continue;
                    }
                    (row as unknown as Record<string, unknown>)[key] = value;
                  }
                }
                sendUpdates.push({ values, matched: hit.length });
                return settled(hit.map((row) => ({ id: row.id })));
              }
              if (table === emailPreferences) {
                preferenceUpdates.push({ values, matched: 1 });
                if ("bounceCount" in values) bounceCount += 1;
                return settled([{ id: "pref-1" }]);
              }
              return settled<{ id: string }>([]);
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            // `resolveEmailSendContextByMessageId` joins to `journey_states`;
            // `emitOutbound`'s endpoint select does not. The join tells the two
            // reads apart, so one fake serves both.
            leftJoin: () => ({
              where: (condition: unknown) => ({
                limit: () =>
                  Promise.resolve(
                    rows
                      .filter((row) =>
                        matches(
                          row as unknown as Record<string, unknown>,
                          condition,
                        ),
                      )
                      .map((row) => ({
                        emailSendId: row.id,
                        toEmail: row.toEmail,
                        templateKey: "onboarding-day-1",
                        sendContactId: null,
                        userId: null,
                        userEmail: null,
                        enrollmentContactId: null,
                        sendUserId: null,
                        sendUserEmail: null,
                      })),
                  ),
              }),
            }),
            // One subscribed endpoint, so the spine has somewhere to deliver.
            where: () => Promise.resolve([{ id: "endpoint-1" }]),
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          if (table === webhookDeliveries) {
            deliveries.push(...(values as { eventType: string }[]));
          }
          return {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve([]),
            }),
            returning: () => Promise.resolve([]),
          };
        },
      };
    },
  };

  return {
    db: db as unknown as Database,
    sends: rows,
    sendUpdates,
    preferenceUpdates,
    bounceCount: () => bounceCount,
    outbound: () => deliveries,
    warnings,
  };
}

/** Never called on the webhook path — present only to satisfy the contract. */
const provider = {
  meta: { id: "test", name: "Test" },
  capabilities: { nativeTracking: false },
  send: async () => ({ id: "unused" }),
} as unknown as EmailProvider;

function mailer(fake: FakeDb) {
  return createTrackedMailer(
    {
      defaultFrom: "test@example.com",
      templates: {} as TemplateRegistry,
      db: fake.db,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string, meta?: unknown) => {
          fake.warnings.push({ message, meta });
        },
        error: () => {},
      } as never,
    },
    { provider },
  );
}

function bounced(
  messageId: string,
  bounce: { class?: string; reason?: string } = { class: "permanent" },
): EmailEvent {
  return {
    type: "email.bounced",
    messageId,
    recipients: ["recipient@example.com"],
    occurredAt: "2026-08-12T10:00:00.000Z",
    bounce: bounce as EmailEvent["bounce"],
    raw: {},
  };
}

/** The outbound emit is fire-and-forget — let its continuation land. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function bouncedEmits(fake: FakeDb): number {
  return fake.outbound().filter((row) => row.eventType === "email.bounced")
    .length;
}

test("THE test: the same bounce delivered three times counts ONCE", async () => {
  // The headline claim. With `bounceThreshold` at 3, an ungated counter turns
  // three redeliveries of ONE bounce into a permanent suppression of an address
  // that never did anything wrong.
  const fake = fakeDb([send("msg-1")]);
  const service = mailer(fake);

  await service.handleWebhook(bounced("msg-1"));
  await drain();
  assert.equal(fake.bounceCount(), 1, "the first delivery must count");
  assert.equal(bouncedEmits(fake), 1, "the first delivery must emit");

  await service.handleWebhook(bounced("msg-1"));
  await drain();
  assert.equal(fake.bounceCount(), 1, "a redelivery must NOT count again");
  assert.equal(bouncedEmits(fake), 1, "a redelivery must NOT emit again");

  await service.handleWebhook(bounced("msg-1"));
  await drain();
  assert.equal(fake.bounceCount(), 1, "still exactly one after a third");
  assert.equal(bouncedEmits(fake), 1, "still exactly one emit after a third");

  // Nothing was suppressed: one count is two short of the threshold.
  assert.equal(fake.preferenceUpdates.length, 1);
});

test("the first delivery still records the bounce facts on the send", async () => {
  // The guard must not cost the row its state. This is the control for the test
  // above: if the claim wrote nothing at all, "counted once" would be vacuous.
  const fake = fakeDb([send("msg-1")]);
  await mailer(fake).handleWebhook(
    bounced("msg-1", { class: "permanent", reason: "550 5.1.1 unknown" }),
  );

  const row = fake.sends[0] as FakeSend;
  assert.equal(row.status, "bounced");
  assert.ok(row.bouncedAt instanceof Date);
  assert.equal(row.bounceType, "permanent");
  assert.equal(row.bounceReason, "550 5.1.1 unknown");
});

test("a SECOND, DISTINCT bounce for the same address still counts", async () => {
  // Do not over-dedupe. Two sends to the same address that both bounce are two
  // bounces, and suppression exists precisely so the second one moves the
  // counter. Dedupe is scoped to (send, bounce), never to the address.
  const fake = fakeDb([send("msg-1"), send("msg-2")]);
  const service = mailer(fake);

  await service.handleWebhook(bounced("msg-1"));
  await service.handleWebhook(bounced("msg-2"));
  await drain();

  assert.equal(fake.bounceCount(), 2);
  assert.equal(bouncedEmits(fake), 2);
});

test("a permanent bounce AFTER a transient one on the same send counts", async () => {
  // The escalation the guard deliberately admits. A soft bounce recorded first
  // must not shield the hard bounce that follows it — that would silently
  // disable suppression for exactly the addresses that need it.
  const fake = fakeDb([send("msg-1")]);
  const service = mailer(fake);

  await service.handleWebhook(bounced("msg-1", { class: "transient" }));
  await drain();
  assert.equal(fake.bounceCount(), 0, "a transient bounce never counts");

  await service.handleWebhook(bounced("msg-1", { class: "permanent" }));
  await drain();
  assert.equal(fake.bounceCount(), 1, "the permanent escalation DOES count");

  // ...and the permanent one is itself idempotent from there on.
  await service.handleWebhook(bounced("msg-1", { class: "permanent" }));
  await drain();
  assert.equal(fake.bounceCount(), 1);
});

test("a transient bounce still auto-suppresses NOTHING, however often it arrives", async () => {
  const fake = fakeDb([send("msg-1")]);
  const service = mailer(fake);

  await service.handleWebhook(bounced("msg-1", { class: "transient" }));
  await service.handleWebhook(bounced("msg-1", { class: "transient" }));
  await drain();

  assert.deepEqual(fake.preferenceUpdates, []);
  assert.equal(fake.bounceCount(), 0);
  // The redelivered transient does not re-emit either.
  assert.equal(bouncedEmits(fake), 1);
  assert.equal((fake.sends[0] as FakeSend).bounceType, "transient");
});

test("a bounce for a send we never recorded STILL counts", async () => {
  // The deliberate edge (requirement 4). `sendRaw` writes no `email_sends` row
  // at all, and a webhook can outrun the send row's commit — so "no matching
  // row" is a REAL bounce we have no send-scoped state to dedupe against.
  // Silently dropping it would disable suppression for those addresses
  // entirely, which is the worse failure, so the count is preserved (today's
  // behaviour) and the un-dedupable path is logged instead of hidden.
  const fake = fakeDb([]);
  const service = mailer(fake);

  await service.handleWebhook(bounced("msg-unknown"));
  await drain();

  assert.equal(fake.bounceCount(), 1);
  assert.ok(
    fake.warnings.some((entry) => /unrecorded send/.test(entry.message)),
    "the un-dedupable path must be logged, not silent",
  );

  // The residual, pinned deliberately rather than left to be discovered: with
  // no send row there is nothing to claim, so a redelivery counts again. The
  // emit does NOT double-fire — it resolves its context from the same missing
  // row and no-ops.
  await service.handleWebhook(bounced("msg-unknown"));
  await drain();
  assert.equal(fake.bounceCount(), 2);
  assert.equal(bouncedEmits(fake), 0);
});

test("opened and clicked are NOT gated — every hit still writes", async () => {
  // The per-hit behaviour of open/click is deliberate and documented in the
  // dispatch branch. The bounce guard must not leak onto it.
  const fake = fakeDb([send("msg-1")]);
  const service = mailer(fake);

  await service.handleWebhook({
    type: "email.opened",
    messageId: "msg-1",
    recipients: ["recipient@example.com"],
    occurredAt: "2026-08-12T10:00:00.000Z",
    raw: {},
  });
  await service.handleWebhook({
    type: "email.opened",
    messageId: "msg-1",
    recipients: ["recipient@example.com"],
    occurredAt: "2026-08-12T10:00:01.000Z",
    raw: {},
  });
  await service.handleWebhook({
    type: "email.clicked",
    messageId: "msg-1",
    recipients: ["recipient@example.com"],
    occurredAt: "2026-08-12T10:00:02.000Z",
    raw: {},
  });
  await drain();

  // Three statements, and every one of them MATCHED a row: an accidental
  // `WHERE openedAt IS NULL` here would leave the second open matching nothing.
  assert.equal(fake.sendUpdates.length, 3);
  for (const update of fake.sendUpdates) {
    assert.equal(update.matched, 1);
  }
});

test("a delivered webhook is untouched by the bounce guard", async () => {
  const fake = fakeDb([send("msg-1")]);
  const service = mailer(fake);

  await service.handleWebhook({
    type: "email.delivered",
    messageId: "msg-1",
    recipients: ["recipient@example.com"],
    occurredAt: "2026-08-12T10:00:00.000Z",
    raw: {},
  });
  await drain();

  assert.equal((fake.sends[0] as FakeSend).status, "delivered");
  assert.deepEqual(fake.preferenceUpdates, []);
  assert.equal(
    fake.outbound().filter((row) => row.eventType === "email.delivered").length,
    1,
  );
});
