import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
    })),
    events: { push: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: {
    run: vi.fn(),
    runNoWait: vi.fn(),
  },
}));

const { buildJourneyRegistry } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");

describe("buildJourneyRegistry", () => {
  it("loads all journeys when filter is '*'", () => {
    const registry = buildJourneyRegistry(journeys, "*");
    expect(registry.count()).toBeGreaterThanOrEqual(2);
    expect(registry.has("activation-welcome")).toBe(true);
    expect(registry.has("test-onboarding")).toBe(true);
  });

  it("loads all journeys when filter is undefined", () => {
    const registry = buildJourneyRegistry(journeys);
    expect(registry.count()).toBeGreaterThanOrEqual(2);
  });

  it("loads all journeys when filter is empty string", () => {
    const registry = buildJourneyRegistry(journeys, "");
    expect(registry.count()).toBeGreaterThanOrEqual(2);
  });

  it("filters to a single journey by ID", () => {
    const registry = buildJourneyRegistry(journeys, "activation-welcome");
    expect(registry.count()).toBe(1);
    expect(registry.has("activation-welcome")).toBe(true);
    expect(registry.has("test-onboarding")).toBe(false);
  });

  it("filters to multiple journeys by comma-separated IDs", () => {
    const registry = buildJourneyRegistry(
      journeys,
      "activation-welcome,test-onboarding",
    );
    expect(registry.count()).toBe(2);
    expect(registry.has("activation-welcome")).toBe(true);
    expect(registry.has("test-onboarding")).toBe(true);
  });

  it("handles whitespace in filter", () => {
    const registry = buildJourneyRegistry(
      journeys,
      " activation-welcome , test-onboarding ",
    );
    expect(registry.count()).toBe(2);
  });

  it("ignores non-existent journey IDs in filter", () => {
    const registry = buildJourneyRegistry(
      journeys,
      "activation-welcome,nonexistent",
    );
    expect(registry.count()).toBe(1);
    expect(registry.has("activation-welcome")).toBe(true);
  });

  it("returns empty registry when no IDs match", () => {
    const registry = buildJourneyRegistry(journeys, "nonexistent");
    expect(registry.count()).toBe(0);
  });
});
