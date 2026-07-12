import { describe, expect, it } from "vitest";
import { toVapiAssistant } from "../agent-mapping.js";

describe("toVapiAssistant", () => {
  it("defaults to the latest fast Claude + maps the system prompt", () => {
    const a = toVapiAssistant({ systemPrompt: "Be helpful." });
    const model = a.model as Record<string, unknown>;
    expect(model.provider).toBe("anthropic");
    expect(model.model).toBe("claude-sonnet-4-6");
    expect(model.messages).toEqual([
      { role: "system", content: "Be helpful." },
    ]);
  });

  it("maps tools to Vapi function tools", () => {
    const a = toVapiAssistant({
      systemPrompt: "x",
      tools: [
        {
          name: "bookAppointment",
          description: "Book a slot",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const model = a.model as Record<string, unknown>;
    expect(model.tools).toEqual([
      {
        type: "function",
        function: {
          name: "bookAppointment",
          description: "Book a slot",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("maps dataSchema to an analysis structuredDataPlan", () => {
    const a = toVapiAssistant({
      systemPrompt: "x",
      dataSchema: {
        type: "object",
        properties: { interested: { type: "boolean" } },
      },
    });
    expect(a.analysisPlan).toEqual({
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: "object",
          properties: { interested: { type: "boolean" } },
        },
      },
    });
  });

  it("maps voice, firstMessage, endCallPhrases, maxDuration, and server", () => {
    const a = toVapiAssistant(
      {
        systemPrompt: "x",
        firstMessage: "Hello",
        voice: { provider: "11labs", voiceId: "rachel" },
        endCallPhrases: ["goodbye"],
        maxDurationSec: 300,
      },
      { url: "https://x/vapi", secret: "s" },
    );
    expect(a.firstMessage).toBe("Hello");
    expect(a.voice).toEqual({ provider: "11labs", voiceId: "rachel" });
    expect(a.endCallPhrases).toEqual(["goodbye"]);
    expect(a.maxDurationSeconds).toBe(300);
    expect(a.server).toEqual({ url: "https://x/vapi", secret: "s" });
  });
});
