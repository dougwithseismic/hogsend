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

describe("unregistered template key guard", () => {
  // The runtime backstop behind the compile-time `TemplateName` typing: a key
  // resolved dynamically (public POST /v1/emails, an admin preview) that was
  // never registered must fail LOUDLY here — naming the bad key and the
  // registered ones — instead of the old cryptic `Cannot read properties of
  // undefined (reading 'component')` deep in the render path.
  it("getTemplate throws an actionable error naming the key and the registered ones", () => {
    expect(() =>
      getTemplate({
        key: "does-not-exist" as never,
        props: { name: "Doug" } as never,
        registry: fixture,
      }),
    ).toThrowError(
      /"does-not-exist" is not registered[\s\S]*Registered templates: hello/,
    );
  });

  it("throws for an inherited Object.prototype key (own-property check, not truthiness)", () => {
    // `registry["toString"]` is truthy (inherited from Object.prototype) but is
    // NOT a registered template — a value-truthiness guard would wave it through
    // and resurface the cryptic render crash. All three getters must reject it.
    expect(() =>
      getTemplateDefinition({ key: "toString" as never, registry: fixture }),
    ).toThrowError(/"toString" is not registered/);
    expect(() =>
      getTemplate({
        key: "constructor" as never,
        props: { name: "Doug" } as never,
        registry: fixture,
      }),
    ).toThrowError(/"constructor" is not registered/);
    expect(() =>
      getPreviewText({
        key: "valueOf" as never,
        props: { name: "Doug" } as never,
        registry: fixture,
      }),
    ).toThrowError(/"valueOf" is not registered/);
  });

  it("reports (none) when the registry is empty", () => {
    expect(() =>
      getTemplateDefinition({
        key: "anything" as never,
        registry: {} as unknown as TemplateRegistry,
      }),
    ).toThrowError(/Registered templates: \(none\)/);
  });
});
