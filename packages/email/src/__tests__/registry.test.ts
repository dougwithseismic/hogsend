import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  createRegistry,
  getPreviewText,
  getTemplate,
  getTemplateDefinition,
  getTemplateNames,
} from "../registry.js";
import type { TemplateRegistry } from "../types.js";

// The package ships no business templates; these tests exercise the registry
// machinery against a tiny self-contained fixture registry (the same shape a
// client app builds in `src/emails/registry.ts`).
function Hello(props: { name: string }) {
  return createElement("div", null, `Hello ${props.name}`);
}

const fixture = {
  hello: {
    component: Hello,
    defaultSubject: "Hello there",
    category: "transactional",
    preview: (props: { name: string }) => `Hi ${props.name}!`,
  },
} as unknown as TemplateRegistry;

describe("template registry", () => {
  it("returns the registered template names", () => {
    const names = getTemplateNames(fixture);
    expect(names).toEqual(["hello"]);
  });

  it("gets a template definition by key", () => {
    const def = getTemplateDefinition({
      key: "hello" as never,
      registry: fixture,
    });
    expect(def.component).toBeTypeOf("function");
    expect(def.defaultSubject).toBe("Hello there");
    expect(def.category).toBe("transactional");
  });

  it("resolves a template with props", () => {
    const result = getTemplate({
      key: "hello" as never,
      props: { name: "Doug" } as never,
      registry: fixture,
    });
    expect(result.element).toBeDefined();
    expect(result.subject).toBe("Hello there");
    expect(result.category).toBe("transactional");
  });

  it("generates preview text", () => {
    const preview = getPreviewText({
      key: "hello" as never,
      props: { name: "Doug" } as never,
      registry: fixture,
    });
    expect(preview).toBe("Hi Doug!");
  });

  it("merges overrides over a base registry", () => {
    const override = {
      hello: {
        component: Hello,
        defaultSubject: "Hey!",
        category: "transactional",
      },
    } as unknown as Partial<TemplateRegistry>;
    const custom = createRegistry(fixture, override);

    const result = getTemplate({
      key: "hello" as never,
      props: { name: "Doug" } as never,
      registry: custom,
    });
    expect(result.subject).toBe("Hey!");
  });
});
