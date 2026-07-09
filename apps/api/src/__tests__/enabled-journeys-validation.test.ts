import { describe, expect, it } from "vitest";

const { buildJourneyRegistry, resolveEnabledFilter, selectJourneyTasks } =
  await import("@hogsend/engine");

// DB-free unit test: resolveEnabledFilter / buildJourneyRegistry /
// selectJourneyTasks are pure. Fake journeys satisfy journeyMetaSchema (so
// registry.register succeeds on the valid-subset path) and carry a sentinel
// task so selectJourneyTasks can be asserted on identity.
type FakeJourney = {
  meta: {
    id: string;
    name: string;
    enabled: boolean;
    trigger: { event: string };
    entryLimit: "once" | "once_per_period" | "unlimited";
    suppress: Record<string, never>;
  };
  task: { __id: string };
};

function fakeJourney(id: string, enabled = true): FakeJourney {
  return {
    meta: {
      id,
      name: id,
      enabled,
      trigger: { event: `${id}.triggered` },
      entryLimit: "unlimited",
      suppress: {},
    },
    task: { __id: id },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: fake journeys cast to the engine's DefinedJourney[]
const asJourneys = (js: FakeJourney[]): any => js as any;

const JOURNEYS = asJourneys([
  fakeJourney("welcome-series"),
  fakeJourney("nps-followup"),
  // A disabled journey is a KNOWN id, not a typo — must NOT trigger a throw.
  fakeJourney("legacy-drip", false),
]);

describe("resolveEnabledFilter validation (ENABLED_JOURNEYS)", () => {
  it("throws on an unknown id and names it + lists known ids + suggests a near miss", () => {
    // "welcom-series" is a one-edit typo of the known "welcome-series".
    expect(() => resolveEnabledFilter(JOURNEYS, "welcom-series")).toThrow(
      /welcom-series/,
    );

    let message = "";
    try {
      resolveEnabledFilter(JOURNEYS, "welcom-series");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ENABLED_JOURNEYS");
    expect(message).toContain('"welcom-series"');
    // did-you-mean suggestion for the near-miss
    expect(message).toContain('did you mean "welcome-series"');
    // known ids listed (including the disabled one)
    expect(message).toContain('"welcome-series"');
    expect(message).toContain('"nps-followup"');
    expect(message).toContain('"legacy-drip"');
  });

  it("throws from BOTH boot paths (buildJourneyRegistry + selectJourneyTasks)", () => {
    expect(() => buildJourneyRegistry(JOURNEYS, "welcom-series")).toThrow(
      /did you mean "welcome-series"/,
    );
    expect(() => selectJourneyTasks(JOURNEYS, "welcom-series")).toThrow(
      /did you mean "welcome-series"/,
    );
  });

  it("reports ALL unknown ids in one throw", () => {
    let message = "";
    try {
      resolveEnabledFilter(JOURNEYS, "bogus-one,welcome-series,bogus-two");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('"bogus-one"');
    expect(message).toContain('"bogus-two"');
    // the valid id is not reported as unknown
    expect(message).toContain("unknown journey ids");
  });

  it("does NOT throw for '*' / undefined / empty-string — enables all", () => {
    expect(resolveEnabledFilter(JOURNEYS, "*")).toBe("*");
    expect(resolveEnabledFilter(JOURNEYS)).toBe("*");
    expect(resolveEnabledFilter(JOURNEYS, "")).toBe("*");

    const registry = buildJourneyRegistry(JOURNEYS, "*");
    expect(registry.count()).toBe(3);
    expect(selectJourneyTasks(JOURNEYS, "*")).toHaveLength(3);
  });

  it("does NOT throw for a valid subset — selects/registers exactly those", () => {
    const filter = "welcome-series,legacy-drip";
    expect(() => resolveEnabledFilter(JOURNEYS, filter)).not.toThrow();

    const registry = buildJourneyRegistry(JOURNEYS, filter);
    expect(registry.count()).toBe(2);
    expect(registry.has("welcome-series")).toBe(true);
    expect(registry.has("legacy-drip")).toBe(true);
    expect(registry.has("nps-followup")).toBe(false);

    const tasks = selectJourneyTasks(JOURNEYS, filter) as unknown as {
      __id: string;
    }[];
    expect(tasks.map((t) => t.__id).sort()).toEqual([
      "legacy-drip",
      "welcome-series",
    ]);
  });

  it("does NOT throw on an empty Set filter (','), enables nothing", () => {
    expect(() => resolveEnabledFilter(JOURNEYS, ",")).not.toThrow();
    expect(buildJourneyRegistry(JOURNEYS, ",").count()).toBe(0);
    expect(selectJourneyTasks(JOURNEYS, ",")).toHaveLength(0);
  });

  it("accepts an extraKnownId (bucket-reaction id) but still throws on a real typo", () => {
    // A `bucket-<id>-on-<kind>` reaction id is a registered journey gated by
    // ENABLED_BUCKETS; it must NOT be rejected when listed in ENABLED_JOURNEYS.
    const reactionId = "bucket-power-users-on-enter";
    expect(() =>
      resolveEnabledFilter(JOURNEYS, `welcome-series,${reactionId}`, [
        reactionId,
      ]),
    ).not.toThrow();
    expect(() =>
      buildJourneyRegistry(JOURNEYS, reactionId, [reactionId]),
    ).not.toThrow();
    expect(() =>
      selectJourneyTasks(JOURNEYS, reactionId, [reactionId]),
    ).not.toThrow();
    // A genuine typo of a top-level journey STILL throws (extraKnownIds present).
    expect(() =>
      resolveEnabledFilter(JOURNEYS, "welcom-series", [reactionId]),
    ).toThrow(/did you mean "welcome-series"/);
  });

  it("does NOT throw when top-level journeys[] is empty (bucket-only client)", () => {
    // A non-"*" filter over an empty journeys[] has nothing to validate — this is
    // what lets a bucket-only createHogsendClient boot with a journeys csv.
    const NONE = asJourneys([]);
    expect(() => resolveEnabledFilter(NONE, "someOtherJourney")).not.toThrow();
    expect(resolveEnabledFilter(NONE, "someOtherJourney")).toBeInstanceOf(Set);
    expect(() => buildJourneyRegistry(NONE, "someOtherJourney")).not.toThrow();
    expect(() => selectJourneyTasks(NONE, "someOtherJourney")).not.toThrow();
    expect(buildJourneyRegistry(NONE, "someOtherJourney").count()).toBe(0);
  });
});
