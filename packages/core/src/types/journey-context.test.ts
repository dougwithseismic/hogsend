import { describe, expect, expectTypeOf, it } from "vitest";
import type { JourneyContext } from "./journey-context.js";

// Compile-time contract only: expectTypeOf assertions are runtime no-ops;
// the real gate is `pnpm check-types` (packages/core tsconfig includes
// src/**/*.test.ts). Pins the D0 claim that repo TS (5.9.2) `const` type
// parameters infer the literal-union return with NO `as const` at the call
// site. The contract closures are never invoked — no runtime JourneyContext
// exists in @hogsend/core (the engine implements variant in phase 1d).
describe("JourneyContext.variant type contract (D0)", () => {
  it("infers Promise<'setup' | 'outcome'> from a bare array literal", () => {
    const contract = (ctx: JourneyContext) =>
      expectTypeOf(
        ctx.variant("welcome-subject", ["setup", "outcome"]),
      ).toEqualTypeOf<Promise<"setup" | "outcome">>();
    expect(contract).toBeTypeOf("function");
  });

  it("rejects an empty arms array at compile time", () => {
    const contract = (ctx: JourneyContext) => {
      // zero arms must never type-check; 1d's validateVariantArms re-guards
      // plain-JS callers at runtime
      // @ts-expect-error — arms is a non-empty string tuple
      return ctx.variant("welcome-subject", []);
    };
    expect(contract).toBeTypeOf("function");
  });
});
