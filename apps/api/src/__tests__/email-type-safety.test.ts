import type { EmailServiceSendOptions } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// Type-level proof of Move 1 / Option B: with `src/emails/templates.d.ts`
// augmenting `@hogsend/email`'s `TemplateRegistryMap`, a known template key
// must accept its props, and a bogus key (or wrong props) must be a type error.
// `EmailServiceSendOptions` is the typed surface of `emailService.send`.

// A known key with correct props type-checks.
const valid: EmailServiceSendOptions<"welcome"> = {
  template: "welcome",
  props: { name: "Doug", dashboardUrl: "https://app.hogsend.com" },
  to: "doug@example.com",
};

// A bogus template key is rejected.
// @ts-expect-error — "not-a-real-template" is not a key of TemplateRegistryMap
const bogusKey: EmailServiceSendOptions<"not-a-real-template"> = {
  template: "not-a-real-template",
  props: {},
  to: "doug@example.com",
};

// Wrong props for a known key are rejected (welcome requires `name: string`).
const wrongProps: EmailServiceSendOptions<"welcome"> = {
  template: "welcome",
  // @ts-expect-error — `name` is required and must be a string
  props: { name: 123 },
  to: "doug@example.com",
};

describe("email template type safety (Option B augmentation)", () => {
  it("compiles the typed send surface against this app's templates", () => {
    expect(valid.template).toBe("welcome");
    expect(bogusKey.template).toBe("not-a-real-template");
    expect(wrongProps.template).toBe("welcome");
  });
});
