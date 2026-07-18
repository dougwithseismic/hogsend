import { defineJourney, hours } from "@hogsend/engine/journeys";
import { pickVariant } from "@hogsend/engine/testing";
import { describe, expect, it } from "vitest";
import { createJourneyTest } from "./index.js";

const user = { id: "u1", email: "dev@acme.com", properties: {} };

const meta = (id: string) => ({
  id,
  name: id,
  enabled: true,
  trigger: { event: `${id}.started` },
  entryLimit: "unlimited" as const,
  suppress: hours(0),
});

describe("ctx.variant — harness parity with the engine", () => {
  it("returns byte-equal arms to the engine's pickVariant for 25 users", async () => {
    for (let i = 0; i < 25; i += 1) {
      const uid = `parity-user-${i}`;
      let arm: string | undefined;
      const journey = defineJourney({
        meta: meta("variant-parity"),
        run: async (_current, ctx) => {
          arm = await ctx.variant("welcome-subject", ["setup", "outcome"]);
        },
      });
      const test = createJourneyTest(journey, {
        user: { id: uid, email: `${uid}@acme.com`, properties: {} },
      });
      await test.run();
      expect(arm).toBe(
        pickVariant({
          journeyId: "variant-parity",
          key: "welcome-subject",
          userId: uid,
          arms: ["setup", "outcome"],
        }),
      );
    }
  });

  it("a seeded arm wins verbatim — even outside the arms array, silently", async () => {
    let arm: string | undefined;
    const journey = defineJourney({
      meta: meta("variant-seeded"),
      run: async (_current, ctx) => {
        arm = await ctx.variant("welcome-subject", ["setup", "outcome"]);
      },
    });
    const test = createJourneyTest(journey, {
      user,
      variants: { "welcome-subject": "legacy-arm" },
    });
    await test.run();
    expect(arm).toBe("legacy-arm");
  });

  it("rejects a malformed key (syntax gate runs before the record read)", async () => {
    const journey = defineJourney({
      meta: meta("variant-bad-key"),
      run: async (_current, ctx) => {
        await ctx.variant("bad key", ["a", "b"]);
      },
    });
    await expect(createJourneyTest(journey, { user }).run()).rejects.toThrow(
      /ctx.variant key/,
    );
  });

  it("arms validation fires only via compute — a seeded key skips it", async () => {
    let arm: string | undefined;
    const journey = defineJourney({
      meta: meta("variant-arms-skip"),
      run: async (_current, ctx) => {
        // Duplicate arms are malformed, but the seeded record short-circuits
        // the compute path (mirrors the engine's degrade-don't-crash split).
        arm = await ctx.variant("pick", ["a", "a"]);
      },
    });
    const seeded = createJourneyTest(journey, {
      user,
      variants: { pick: "a" },
    });
    await seeded.run();
    expect(arm).toBe("a");

    const fresh = createJourneyTest(journey, { user });
    await expect(fresh.run()).rejects.toThrow(RangeError);
  });

  it("infers the literal arm union (compile-only assertion)", async () => {
    const journey = defineJourney({
      meta: meta("variant-union"),
      run: async (_current, ctx) => {
        const arm = await ctx.variant("k", ["a", "b"]);
        // Compile-time: repo TS 5.9.2 + the `const` type parameter infer
        // Promise<"a" | "b"> with no `as const` at the call site.
        const union: "a" | "b" = arm;
        expect(["a", "b"]).toContain(union);
      },
    });
    await createJourneyTest(journey, { user }).run();
  });
});
