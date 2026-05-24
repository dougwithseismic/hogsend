import { describe, expect, it } from "vitest";
import { getTemplate } from "../registry.js";
import { renderToHtml, renderToPlainText } from "../render.js";

describe("renderToHtml", () => {
  it("renders welcome email to HTML", async () => {
    const { element } = getTemplate("welcome", { name: "Doug" });
    const html = await renderToHtml(element);
    expect(html).toContain("Welcome to Hogsend");
    expect(html).toContain("Doug");
    expect(html).toContain("<html");
  });

  it("renders password-reset email to HTML", async () => {
    const { element } = getTemplate("password-reset", {
      name: "Jane",
      resetUrl: "https://app.hogsend.com/reset/token123",
    });
    const html = await renderToHtml(element);
    expect(html).toContain("Reset your password");
    expect(html).toContain("token123");
  });

  it("renders journey-notification email to HTML", async () => {
    const { element } = getTemplate("journey-notification", {
      name: "Alex",
      journeyName: "Onboarding",
      eventName: "user_signed_up",
      body: "Welcome aboard!",
    });
    const html = await renderToHtml(element);
    expect(html).toContain("Onboarding");
    expect(html).toContain("Welcome aboard!");
  });
});

describe("renderToPlainText", () => {
  it("renders welcome email to plain text", async () => {
    const { element } = getTemplate("welcome", { name: "Doug" });
    const text = await renderToPlainText(element);
    expect(text.toLowerCase()).toContain("welcome to hogsend");
    expect(text).toContain("Doug");
    expect(text).not.toContain("<html");
  });
});
