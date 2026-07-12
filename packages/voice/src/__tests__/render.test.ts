import { describe, expect, it } from "vitest";
import { defineVoiceAgent, defineVoiceTool } from "../define.js";
import { createVoiceToolRegistry, withSources } from "../registry.js";
import { interpolate, renderVoiceAgent } from "../render.js";
import type { VoiceAgentRegistry } from "../types.js";

describe("interpolate", () => {
  it("replaces {{var}} with values, tolerating inner whitespace", () => {
    expect(
      interpolate("Hi {{name}}, from {{ brand }}", {
        name: "Ada",
        brand: "Hogsend",
      }),
    ).toBe("Hi Ada, from Hogsend");
  });

  it("coerces non-string values", () => {
    expect(interpolate("You have {{n}} slots", { n: 3 })).toBe(
      "You have 3 slots",
    );
  });

  it("leaves an unmatched placeholder verbatim (downstream may fill it)", () => {
    expect(interpolate("Call {{missing}}", {})).toBe("Call {{missing}}");
  });
});

describe("renderVoiceAgent", () => {
  const setter = defineVoiceAgent({
    category: "journey",
    build: (p: { businessName: string }) => ({
      systemPrompt: "You book appointments for {{businessName}}.",
      firstMessage: `Hi, this is the assistant for ${p.businessName}.`,
      endCallPhrases: ["Goodbye from {{businessName}}"],
    }),
  });

  const registry = {
    "appointment-setter": setter,
  } as unknown as VoiceAgentRegistry;

  it("builds from props then interpolates variables into prompt fields", () => {
    const { config, category } = renderVoiceAgent({
      key: "appointment-setter" as never,
      props: { businessName: "Acme" } as never,
      registry,
      variables: { businessName: "Acme" },
    });
    expect(category).toBe("journey");
    expect(config.systemPrompt).toBe("You book appointments for Acme.");
    expect(config.firstMessage).toBe("Hi, this is the assistant for Acme.");
    expect(config.endCallPhrases).toEqual(["Goodbye from Acme"]);
  });

  it("throws a loud error for an unregistered key", () => {
    expect(() =>
      renderVoiceAgent({
        key: "nope" as never,
        props: {} as never,
        registry,
      }),
    ).toThrow(/not registered/);
  });
});

describe("withSources", () => {
  it("stamps a best-effort .ts sourcePath per agent", () => {
    const registry = {
      "appointment-setter": defineVoiceAgent({
        build: () => ({ systemPrompt: "x" }),
      }),
    } as unknown as VoiceAgentRegistry;
    const stamped = withSources(
      "/app/src/voice",
      registry,
    ) as unknown as Record<string, { sourcePath?: string }>;
    expect(stamped["appointment-setter"]?.sourcePath).toBe(
      "/app/src/voice/appointment-setter.ts",
    );
  });
});

describe("createVoiceToolRegistry", () => {
  const bookTool = defineVoiceTool({
    spec: {
      name: "bookAppointment",
      parameters: { type: "object", properties: {} },
    },
    handler: (args: { slotIso: string }) => ({
      booked: true,
      slot: args.slotIso,
    }),
  });

  it("indexes tools by spec.name", () => {
    const registry = createVoiceToolRegistry([bookTool]);
    expect(Object.keys(registry)).toEqual(["bookAppointment"]);
  });

  it("throws on a duplicate tool name", () => {
    expect(() => createVoiceToolRegistry([bookTool, bookTool])).toThrow(
      /Duplicate voice tool/,
    );
  });
});
