import type { EmailEvent } from "@hogsend/engine";
import { createTrackedMailer } from "@hogsend/engine";
import { createResendProvider } from "@hogsend/plugin-resend";
import { describe, expect, it, vi } from "vitest";
import { templates } from "../emails/index.js";

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
 * A minimal chainable fake `db` capturing the `.update(table).set(values)`
 * calls the mailer makes against `emailSends` / `emailPreferences`. We can't
 * tell the tables apart by reference here, so we record every `set()` payload
 * and assert on the shapes (status / bounceType for the send row; suppressed /
 * bounceCount for the preference rows).
 */
function makeFakeDb() {
  const sets: Array<Record<string, unknown>> = [];
  const wheres: unknown[] = [];
  // `select` chain used by the fire-and-forget outbound enrichment
  // (`resolveEmailSendContextByMessageId`); returns no rows so it's a clean
  // no-op and never touches outbound.
  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve([]),
  };
  const db = {
    select() {
      return selectChain;
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          sets.push(values);
          return {
            where(cond: unknown) {
              wheres.push(cond);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as never, sets, wheres };
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
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.bounced",
          recipients: ["a@x.com", "b@x.com", "c@x.com"],
          bounce: { class: "permanent", code: "HardBounce" },
        }),
        "resend",
      );

      // One bounceCount update per unique recipient.
      const prefUpdates = sets.filter((s) => "bounceCount" in s);
      expect(prefUpdates).toHaveLength(3);
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
      const { db, sets } = makeFakeDb();
      const service = makeMailer({ db });

      await service.handleWebhook(
        emailEvent({
          type: "email.complained",
          recipients: ["a@x.com", "b@x.com"],
          bounce: { class: "complaint", code: "complaint" },
        }),
        "resend",
      );

      const suppressUpdates = sets.filter((s) => s.suppressed === true);
      expect(suppressUpdates).toHaveLength(2);
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
