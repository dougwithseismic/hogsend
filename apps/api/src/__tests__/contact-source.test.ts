import { describe, expect, it } from "vitest";

// Same test-DB env the engine's import-time env validation reads.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  buildContactSourceRegistry,
  ContactSourceRegistry,
  contactSourceToWebhookSource,
  defaultColdPosture,
  defineContactSource,
  isColdChannelAllowed,
  resolveColdPosture,
} = await import("@hogsend/engine");

type WebhookSourceCtx = Parameters<
  ReturnType<typeof contactSourceToWebhookSource>["transform"]
>[1];

const auth = {
  type: "match",
  header: "x-secret",
  envKey: "TEST_SECRET",
} as const;

function makeSource(over?: {
  coldPosture?: Record<string, "allow" | "block">;
}) {
  return defineContactSource({
    meta: { id: "clay", name: "Clay" },
    auth,
    transform: async (payload: { email: string }) => ({
      event: "prospect.sourced",
      userEmail: payload.email,
      eventProperties: {},
      contactProperties: { company: "Acme" },
    }),
    ...over,
  });
}

describe("defineContactSource — cold posture", () => {
  it("defaults to email-only (email allow, everything else block)", () => {
    const src = makeSource();
    expect(src.coldPosture).toEqual({ email: "allow" });
    expect(isColdChannelAllowed(src.coldPosture, "email")).toBe(true);
    expect(isColdChannelAllowed(src.coldPosture, "sms")).toBe(false);
    expect(isColdChannelAllowed(src.coldPosture, "discord")).toBe(false);
  });

  it("merges a declared posture over the safe default", () => {
    const src = makeSource({ coldPosture: { discord: "allow" } });
    expect(src.coldPosture).toEqual({ email: "allow", discord: "allow" });
    expect(isColdChannelAllowed(src.coldPosture, "email")).toBe(true);
    expect(isColdChannelAllowed(src.coldPosture, "discord")).toBe(true);
    expect(isColdChannelAllowed(src.coldPosture, "sms")).toBe(false);
  });

  it("lets a source explicitly block cold email", () => {
    const src = makeSource({ coldPosture: { email: "block" } });
    expect(isColdChannelAllowed(src.coldPosture, "email")).toBe(false);
  });

  it("defaultColdPosture / resolveColdPosture are pure and non-shared", () => {
    const a = defaultColdPosture();
    a.sms = "allow";
    expect(defaultColdPosture()).toEqual({ email: "allow" });
    expect(resolveColdPosture({ sms: "allow" })).toEqual({
      email: "allow",
      sms: "allow",
    });
  });

  it("requires meta.id", () => {
    expect(() =>
      defineContactSource({
        meta: { id: "", name: "x" },
        auth,
        transform: async () => null,
      }),
    ).toThrow(/meta\.id/);
  });
});

describe("contactSourceToWebhookSource", () => {
  it("preserves meta + auth and delegates transform", async () => {
    const src = makeSource();
    const ws = contactSourceToWebhookSource(src);
    expect(ws.meta).toEqual(src.meta);
    expect(ws.auth).toEqual(auth);
    const ev = await ws.transform(
      { email: "a@example.com" },
      {} as WebhookSourceCtx,
    );
    expect(ev).toMatchObject({
      event: "prospect.sourced",
      userEmail: "a@example.com",
      contactProperties: { company: "Acme" },
    });
  });
});

describe("ContactSourceRegistry", () => {
  it("classifies a stamped source as a prospect origin", () => {
    const reg = buildContactSourceRegistry([makeSource()]);
    expect(reg.has("clay")).toBe(true);
    expect(reg.isProspectSource("clay")).toBe(true);
    expect(reg.isProspectSource("api")).toBe(false);
    expect(reg.isProspectSource(null)).toBe(false);
    expect(reg.isProspectSource(undefined)).toBe(false);
    expect(reg.count()).toBe(1);
  });

  it("an empty registry treats nothing as a prospect source", () => {
    const reg = new ContactSourceRegistry();
    expect(reg.isProspectSource("clay")).toBe(false);
  });
});
