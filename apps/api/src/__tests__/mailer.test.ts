import { emailSends } from "@hogsend/db";
import type { EmailEvent } from "@hogsend/engine";
import { createTrackedMailer } from "@hogsend/engine";
import { createResendProvider } from "@hogsend/plugin-resend";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { templates } from "../emails/index.js";

const dialect = new PgDialect();

// Compile a captured drizzle WHERE to its bound params so a batched
// `... WHERE email IN ($1,$2,…)` suppression can be asserted to cover every
// recipient (the params ARE the recipient list) without counting query calls.
const whereParams = (cond: unknown): unknown[] =>
  dialect.sqlToQuery(cond as SQL).params;

/** `bounced_at` → `bouncedAt`. */
const camel = (column: string): string =>
  column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

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
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
  bounceType: string | null;
  bounceReason: string | null;
}

/** One recorded `email_sends` row — the send the webhooks below report on. */
function fakeSend(over: Partial<FakeSend> = {}): FakeSend {
  return {
    id: "send-1",
    messageId: "msg_1",
    toEmail: "user@example.com",
    status: "sent",
    openedAt: null,
    clickedAt: null,
    bouncedAt: null,
    bounceType: null,
    bounceReason: null,
    ...over,
  };
}

/** A resolved promise that also answers `.returning()`, like drizzle's builder. */
function settled<T>(
  rows: T[],
  onReturning: () => Promise<T[]> = () => Promise.resolve(rows),
): Promise<T[]> & { returning: () => Promise<T[]> } {
  const promise = Promise.resolve(rows) as Promise<T[]> & {
    returning: () => Promise<T[]>;
  };
  promise.returning = onReturning;
  return promise;
}

const baseConfig = {
  defaultFrom: "Hogsend <noreply@hogsend.com>",
  templates,
};

function makeMailer(extra?: Record<string, unknown>) {
  return createTrackedMailer(
    { ...baseConfig, ...extra },
    {
      provider: createResendProvider({ apiKey: "re_test_key" }),
    },
  );
}

/**
 * A chainable fake `db` capturing the `.update(table).set(values)` calls the
 * mailer makes against `emailSends` / `emailPreferences`. Every `set()` payload
 * is recorded so tests can assert on shapes (status / bounceType for the send
 * row; suppressed / bounceCount for the preference rows).
 *
 * `email_sends` rows are MODELLED, not faked away. The bounce leg claims its
 * send with a guarded `UPDATE … RETURNING id` and decides from the returned row
 * count whether to count the bounce and emit — so `.returning()` here evaluates
 * the statement's real WHERE (rendered through drizzle's own pg dialect)
 * against modelled row state and writes the matched rows through, exactly as
 * the driver would. A `.returning()` that answered a constant would make these
 * tests pass whether or not the engine guards at all, which is the
 * vacuous-green trap: it would certify nothing.
 */
function makeFakeDb(sends: FakeSend[] = [fakeSend()]) {
  const sets: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  const row = (send: FakeSend) => send as unknown as Record<string, unknown>;
  const db = {
    select() {
      return {
        from: () => ({
          // `resolveEmailSendContextByMessageId` LEFT JOINs `journey_states`;
          // `emitOutbound`'s endpoint read does not. The join tells the two
          // reads apart, so one fake serves both.
          leftJoin: () => ({
            where: (cond: unknown) => ({
              limit: () =>
                Promise.resolve(
                  sends
                    .filter((send) => matches(row(send), cond))
                    .map((send) => ({
                      emailSendId: send.id,
                      toEmail: send.toEmail,
                      templateKey: "welcome",
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
          // No subscribed outbound endpoints, so the fire-and-forget emit
          // returns before it writes a delivery row.
          where: () => Promise.resolve([]),
        }),
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          sets.push(values);
          return {
            where(cond: unknown) {
              wheres.push(cond);
              // Preference rows are counted, not modelled: nothing on this
              // path reads their `.returning()`, so answering one would be a
              // guess. Refuse loudly if that ever changes.
              if (table !== emailSends) {
                return settled<{ id: string }>([], () => {
                  throw new Error(
                    "fake db: only `email_sends` rows are modelled",
                  );
                });
              }
              const hit = sends.filter((send) => matches(row(send), cond));
              for (const send of hit) {
                for (const [key, value] of Object.entries(values)) {
                  // Drizzle `sql` expressions (the counter increments) carry no
                  // literal value; leave the modelled column alone.
                  if (
                    value &&
                    typeof value === "object" &&
                    "queryChunks" in value
                  ) {
                    continue;
                  }
                  row(send)[key] = value;
                }
              }
              return settled(hit.map((send) => ({ id: send.id })));
            },
          };
        },
      };
    },
  };
  return { db: db as never, sets, wheres, sends };
}

function emailEvent(
  over: Partial<EmailEvent> & { type: EmailEvent["type"] },
): EmailEvent {
  return {
    messageId: "msg_1",
    recipients: ["user@example.com"],
    occurredAt: "2024-01-01T00:00:00Z",
    raw: {},
    ...over,
  };
}

describe("createTrackedMailer", () => {
  it("returns an object with all service methods", () => {
    const service = makeMailer();

    expect(service.send).toBeTypeOf("function");
    expect(service.sendRaw).toBeTypeOf("function");
    expect(service.sendBatch).toBeTypeOf("function");
    expect(service.render).toBeTypeOf("function");
    expect(service.handleWebhook).toBeTypeOf("function");
  });

  describe("render", () => {
    it("renders welcome template to html, text, subject, category", async () => {
      const service = makeMailer();

      const result = await service.render({
        template: "welcome",
        props: { name: "Doug" },
      });

      expect(result.html).toContain("Doug");
      expect(result.html).toContain("<html");
      expect(result.text).toContain("Doug");
      expect(result.text).not.toContain("<html");
      expect(result.subject).toBe("Welcome to Hogsend");
      expect(result.category).toBe("transactional");
    });

    it("renders password-reset template", async () => {
      const service = makeMailer();

      const result = await service.render({
        template: "password-reset",
        props: {
          name: "Jane",
          resetUrl: "https://app.hogsend.com/reset/abc",
        },
      });

      expect(result.subject).toBe("Reset your password");
      expect(result.category).toBe("transactional");
      expect(result.html).toContain("abc");
    });

    it("renders journey-notification template", async () => {
      const service = makeMailer();

      const result = await service.render({
        template: "journey-notification",
        props: {
          name: "Alex",
          journeyName: "Onboarding",
          eventName: "user_signed_up",
          body: "Welcome aboard!",
        },
      });

      expect(result.subject).toBe("Journey notification");
      expect(result.category).toBe("journey");
      expect(result.html).toContain("Welcome aboard!");
    });
  });

  describe("handleWebhook (takes an already-verified EmailEvent)", () => {
    it("no longer requires a webhookSecret — dispatches without throwing", async () => {
      const service = makeMailer();

      const result = await service.handleWebhook(
        emailEvent({ type: "email.delivered" }),
        "resend",
      );

      expect(result.type).toBe("email.delivered");
      expect(result.handled).toBe(false); // no user handler registered
    });

    it("invokes the matching user webhook handler with the EmailEvent", async () => {
      const onBounced = vi.fn();
      const service = makeMailer({
        webhookHandlers: { "email.bounced": onBounced },
      });

      const event = emailEvent({
        type: "email.bounced",
        bounce: { class: "permanent", code: "HardBounce", reason: "nope" },
      });
      const result = await service.handleWebhook(event, "resend");

      expect(result.handled).toBe(true);
      expect(onBounced).toHaveBeenCalledWith(event);
    });

    it("records bounceType=class + bounceReason on the send row", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          bounce: {
            class: "transient",
            code: "SoftBounce",
            reason: "mailbox full",
          },
        }),
        "resend",
      );

      const sendUpdate = sets.find((s) => s.status === "bounced");
      expect(sendUpdate?.bounceType).toBe("transient");
      expect(sendUpdate?.bounceReason).toBe("mailbox full");
    });

    it("suppresses ONLY on a permanent bounce (bounceCount increment)", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          bounce: { class: "permanent", code: "HardBounce" },
        }),
        "resend",
      );

      // The preference-row update is the one carrying a bounceCount bump.
      const prefUpdate = sets.find((s) => "bounceCount" in s);
      expect(prefUpdate).toBeDefined();
    });

    it("does NOT re-count a REDELIVERED bounce", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });
      const event = emailEvent({
        type: "email.bounced",
        bounce: { class: "permanent", code: "HardBounce" },
      });

      // SNS is at-least-once and the control plane re-drives a `pending` row,
      // so the SAME bounce arrives twice. `bounceThreshold` is 3: counting a
      // redelivery would let three copies of ONE bounce permanently suppress a
      // deliverable address. The second delivery's guarded UPDATE matches no
      // row, so it claims nothing and counts nothing.
      await service.handleWebhook(event, "resend");
      await service.handleWebhook(event, "resend");

      expect(sets.filter((s) => "bounceCount" in s)).toHaveLength(1);
    });

    it("does NOT suppress on a transient bounce", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          bounce: { class: "transient", code: "SoftBounce" },
        }),
        "resend",
      );

      const prefUpdate = sets.find((s) => "bounceCount" in s);
      expect(prefUpdate).toBeUndefined();
      // It IS still recorded as bounced on the send row.
      expect(sets.some((s) => s.status === "bounced")).toBe(true);
    });

    it("does NOT suppress on an unknown bounce", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          bounce: { class: "unknown", code: "Weird" },
        }),
        "resend",
      );

      expect(sets.some((s) => "bounceCount" in s)).toBe(false);
    });

    it("iterates ALL recipients on a multi-recipient permanent bounce", async () => {
      const { db, sets, wheres } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          recipients: ["a@x.com", "b@x.com", "c@x.com"],
          bounce: { class: "permanent", code: "HardBounce" },
        }),
        "resend",
      );

      // ONE batched `UPDATE … WHERE email IN (…)` covering every recipient.
      const prefUpdates = sets.filter((s) => "bounceCount" in s);
      expect(prefUpdates).toHaveLength(1);
      expect(whereParams(wheres.at(-1))).toEqual(
        expect.arrayContaining(["a@x.com", "b@x.com", "c@x.com"]),
      );
    });

    it("caps suppression on a fan-out bounce (>100 recipients → skip)", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      const recipients = Array.from({ length: 101 }, (_, i) => `u${i}@x.com`);
      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          recipients,
          bounce: { class: "permanent", code: "HardBounce" },
        }),
        "resend",
      );

      // No bounceCount updates at all — the cap skipped suppression.
      expect(sets.some((s) => "bounceCount" in s)).toBe(false);
    });

    it("suppresses every recipient on a complaint", async () => {
      const { db, sets, wheres } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.complained",
          recipients: ["a@x.com", "b@x.com"],
          bounce: { class: "complaint", code: "complaint" },
        }),
        "resend",
      );

      // ONE batched suppression `UPDATE … WHERE email IN (…)` for all recipients.
      const suppressUpdates = sets.filter((s) => s.suppressed === true);
      expect(suppressUpdates).toHaveLength(1);
      expect(whereParams(wheres.at(-1))).toEqual(
        expect.arrayContaining(["a@x.com", "b@x.com"]),
      );
    });

    it("opened/clicked echoes only touch DB status (no suppression)", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({ type: "email.opened" }),
        "resend",
      );
      await service.handleWebhook(
        emailEvent({ type: "email.clicked" }),
        "resend",
      );

      expect(sets.some((s) => "bounceCount" in s)).toBe(false);
      expect(sets.some((s) => s.status === "opened")).toBe(true);
      expect(sets.some((s) => s.status === "clicked")).toBe(true);
    });

    it("delivery_delayed is a no-op", async () => {
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      const result = await service.handleWebhook(
        emailEvent({ type: "email.delivery_delayed" }),
        "resend",
      );

      expect(result.handled).toBe(false);
      expect(sets).toHaveLength(0);
    });
  });

  describe("RORO pattern", () => {
    it("send accepts a single options object", () => {
      const service = makeMailer();
      expect(service.send.length).toBe(1);
    });

    it("sendRaw accepts a single options object", () => {
      const service = makeMailer();
      expect(service.sendRaw.length).toBe(1);
    });

    it("sendBatch accepts a single options object", () => {
      const service = makeMailer();
      expect(service.sendBatch.length).toBe(1);
    });

    it("render accepts a single options object", () => {
      const service = makeMailer();
      expect(service.render.length).toBe(1);
    });
  });
});
