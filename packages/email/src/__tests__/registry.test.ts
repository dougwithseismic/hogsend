import { describe, expect, it } from "vitest";
import {
  createRegistry,
  defaultRegistry,
  getPreviewText,
  getTemplate,
  getTemplateDefinition,
  getTemplateNames,
} from "../registry.js";

describe("template registry", () => {
  it("returns all registered template names", () => {
    const names = getTemplateNames();
    expect(names).toContain("welcome");
    expect(names).toContain("password-reset");
    expect(names).toContain("journey-notification");
    expect(names).toHaveLength(3);
  });

  it("gets a template definition by key", () => {
    const def = getTemplateDefinition("welcome");
    expect(def.component).toBeTypeOf("function");
    expect(def.defaultSubject).toBe("Welcome to Hogsend");
    expect(def.category).toBe("transactional");
  });

  it("resolves welcome template with props", () => {
    const result = getTemplate("welcome", { name: "Doug" });
    expect(result.element).toBeDefined();
    expect(result.subject).toBe("Welcome to Hogsend");
    expect(result.category).toBe("transactional");
  });

  it("resolves password-reset template with props", () => {
    const result = getTemplate("password-reset", {
      name: "Doug",
      resetUrl: "https://app.hogsend.com/reset/abc",
      expiresInMinutes: 30,
    });
    expect(result.element).toBeDefined();
    expect(result.subject).toBe("Reset your password");
  });

  it("resolves journey-notification template with props", () => {
    const result = getTemplate("journey-notification", {
      name: "Doug",
      journeyName: "Onboarding",
      eventName: "user_signed_up",
      body: "You just signed up!",
    });
    expect(result.element).toBeDefined();
    expect(result.subject).toBe("Journey notification");
    expect(result.category).toBe("journey");
  });

  it("generates preview text for welcome", () => {
    const preview = getPreviewText("welcome", { name: "Doug" });
    expect(preview).toBe("Welcome to Hogsend, Doug!");
  });

  it("generates preview text for journey-notification", () => {
    const preview = getPreviewText("journey-notification", {
      name: "Doug",
      journeyName: "Onboarding",
      eventName: "user_signed_up",
      body: "Hello",
    });
    expect(preview).toBe("Onboarding: user_signed_up");
  });

  it("creates a custom registry with overrides", () => {
    const custom = createRegistry({
      welcome: {
        ...defaultRegistry.welcome,
        defaultSubject: "Hey there!",
      },
    });

    const result = getTemplate("welcome", { name: "Doug" }, custom);
    expect(result.subject).toBe("Hey there!");
  });
});
