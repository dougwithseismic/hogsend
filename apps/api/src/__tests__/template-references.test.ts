import type { SendEmailOptions } from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import { templates } from "../emails/registry.js";
import { Templates } from "../journeys/constants/templates.js";

// Guards the exact bug that shipped the activation journey broken: a journey
// referencing an email key that was never registered (a typo, or an
// `activation/…` slash-key when the registry only has the `activation-…`
// hyphen-key). The `satisfies Record<string, TemplateName>` on the `Templates`
// constant already makes this a COMPILE error; this asserts it at runtime too,
// so drift between the constant and the registry can never ship a send that
// fails to load.
describe("journey template references", () => {
  const registeredKeys = new Set(Object.keys(templates));

  it("every Templates constant maps to a registered email template", () => {
    for (const [name, key] of Object.entries(Templates)) {
      expect(
        registeredKeys.has(key),
        `Templates.${name} -> "${key}" is not registered in src/emails/registry.ts`,
      ).toBe(true);
    }
  });

  it("rejects an unregistered key passed to sendEmail() at COMPILE time (locks email.ts)", () => {
    // Locks the PRIMARY fix — `SendEmailOptions.template` is the registered-key
    // union (`TemplateName`), NOT `string`. These are TYPE-ONLY assertions
    // (never executed; `SendEmailOptions` is a type-only import, so no engine
    // module loads). A registered key is accepted:
    const _ok: SendEmailOptions = {
      to: "a@b.com",
      userId: "u",
      template: "activation-quickstart",
      subject: "x",
    };
    // ...and the old broken slash-key is rejected. If email.ts ever widens
    // `template` back to `string`, this @ts-expect-error goes unused and tsc
    // fails — exactly the build-time-should-fail regression we guard against.
    const _bad: SendEmailOptions = {
      to: "a@b.com",
      userId: "u",
      // @ts-expect-error — "activation/welcome" is not a registered template key.
      template: "activation/welcome",
      subject: "x",
    };
    expect(_ok.template).toBe("activation-quickstart");
    expect(_bad).toBeDefined();
  });

  it("registry keys and the templates.d.ts augmentation stay in lockstep (mapped type)", () => {
    // `templates: TemplateRegistry` is `{ [K in TemplateName]: … }`, so tsc
    // already forces registry.ts and templates.d.ts to hold EXACTLY the same
    // keys. This just documents that the registry is non-empty at runtime.
    expect(registeredKeys.size).toBeGreaterThan(0);
  });
});
