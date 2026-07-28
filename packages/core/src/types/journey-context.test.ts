import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  EmailHistoryOptions,
  JourneyContext,
  SmsHistoryOptions,
} from "./journey-context.js";

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

// The NO-CARRIER half of the read-path narrowing contract, and the only
// program in the repo that can pin it: `@hogsend/core` is the leaf of the
// package graph, so nothing here augments `EmailTemplateKeyCarrier` and the
// `EmailTemplateKeyCarrier extends { key: infer K }` check is FALSE. That is
// the state of any program consuming core without the engine, and the state
// every conditional-type fallback below is written for.
//
// The engine-side twin (packages/engine/src/journeys/history-template-keys
// .test.ts) cannot cover this: the engine loads the augmentation, so it only
// ever exercises the inner `[K] extends [never] ? string` branch. Deleting the
// OUTER `: string` fallback would leave both entry-level surfaces typed
// `never` — `ctx.history.email` becomes uncallable for every consumer without
// registered templates — and only this file goes red.
describe("history template keys with no carrier augmentation", () => {
  it("widens the email template key back to string", () => {
    expectTypeOf<EmailHistoryOptions["template"]>().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });

  it("widens the sms template key back to string", () => {
    expectTypeOf<SmsHistoryOptions["template"]>().toEqualTypeOf<string>();
    expect(true).toBe(true);
  });
});
