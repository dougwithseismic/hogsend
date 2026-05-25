import { describe, expect, it } from "vitest";
import { createEmailService } from "../service.js";

const baseConfig = {
  apiKey: "re_test_key",
  defaultFrom: "Hogsend <noreply@hogsend.com>",
};

describe("createEmailService", () => {
  it("returns an object with all service methods", () => {
    const service = createEmailService(baseConfig);

    expect(service.send).toBeTypeOf("function");
    expect(service.sendRaw).toBeTypeOf("function");
    expect(service.sendBatch).toBeTypeOf("function");
    expect(service.render).toBeTypeOf("function");
    expect(service.handleWebhook).toBeTypeOf("function");
  });

  describe("render", () => {
    it("renders welcome template to html, text, subject, category", async () => {
      const service = createEmailService(baseConfig);

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
      const service = createEmailService(baseConfig);

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
      const service = createEmailService(baseConfig);

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

  describe("handleWebhook", () => {
    it("throws if no webhookSecret configured", async () => {
      const service = createEmailService(baseConfig);

      await expect(
        service.handleWebhook({ payload: "{}", headers: {} }),
      ).rejects.toThrow("webhookSecret is required");
    });
  });

  describe("RORO pattern", () => {
    it("send accepts a single options object", () => {
      const service = createEmailService(baseConfig);
      expect(service.send.length).toBe(1);
    });

    it("sendRaw accepts a single options object", () => {
      const service = createEmailService(baseConfig);
      expect(service.sendRaw.length).toBe(1);
    });

    it("sendBatch accepts a single options object", () => {
      const service = createEmailService(baseConfig);
      expect(service.sendBatch.length).toBe(1);
    });

    it("render accepts a single options object", () => {
      const service = createEmailService(baseConfig);
      expect(service.render.length).toBe(1);
    });

    it("handleWebhook accepts a single options object", () => {
      const service = createEmailService(baseConfig);
      expect(service.handleWebhook.length).toBe(1);
    });
  });
});
