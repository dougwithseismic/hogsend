import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { createHogsendClient, defineContactSource } = await import(
  "@hogsend/engine"
);

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const claySource = defineContactSource({
  meta: { id: "clay", name: "Clay" },
  auth: { type: "match", header: "x-clay-secret", envKey: "CLAY_SECRET" },
  transform: async (payload: { email: string }) => ({
    event: "prospect.sourced",
    userEmail: payload.email,
    eventProperties: {},
  }),
});

describe("createHogsendClient — contactSources wiring", () => {
  it("registers a contact source in the contact-source AND connector registries", () => {
    const client = createHogsendClient({
      overrides: { hatchet: mockHatchet },
      contactSources: [claySource],
    });

    // Classifiable as a prospect origin.
    expect(client.contactSourceRegistry.has("clay")).toBe(true);
    expect(client.contactSourceRegistry.isProspectSource("clay")).toBe(true);
    expect(client.contactSourceRegistry.isProspectSource("api")).toBe(false);

    // Served on the webhook path (POST /v1/webhooks/:sourceId) so its transform
    // flows through ingestEvent — provenance is stamped from meta.id.
    const connector = client.connectorRegistry.get("clay");
    expect(connector).toBeDefined();
    expect(connector?.meta.transport ?? "webhook").toBe("webhook");
  });

  it("no contactSources ⇒ empty registry, nothing is a prospect source", () => {
    const client = createHogsendClient({
      overrides: { hatchet: mockHatchet },
    });
    expect(client.contactSourceRegistry.isProspectSource("clay")).toBe(false);
  });
});
