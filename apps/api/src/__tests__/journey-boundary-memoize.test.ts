import { createMemoize } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

/**
 * Regression: `createMemoize` must invoke `ctx.memo` with its `this` PRESERVED.
 * The Hatchet SDK's `memo` body opens with `this.throwIfCancelled()`, so calling
 * it via an extracted `const memo = ctx.memo; memo(...)` drops the binding and
 * throws "Cannot read properties of undefined (reading 'throwIfCancelled')" the
 * moment eviction is live (a hatchet-lite >= v0.80.0) — breaking EVERY journey
 * side effect (sendEmail / sendConnectorAction / ctx.trigger). The earlier memo
 * stubs were plain arrow fns (no `this`), so they never caught it.
 */
describe("createMemoize — Hatchet `this` binding", () => {
  it("calls ctx.memo bound to ctx when eviction is live", async () => {
    const ctx: {
      supportsEviction: boolean;
      tag: string;
      memo<T>(fn: () => Promise<T> | T, deps: unknown[]): Promise<T>;
    } = {
      supportsEviction: true,
      tag: "ctx",
      // Method form: touches `this`, exactly like the SDK's real `memo`.
      memo<T>(fn: () => Promise<T> | T, _deps: unknown[]): Promise<T> {
        if (this.tag !== "ctx") {
          throw new TypeError("memo called without its `this` binding");
        }
        return Promise.resolve(fn());
      },
    };
    const memoize = createMemoize(ctx);
    const out = await memoize(["k"], () => "ran");
    expect(out).toBe("ran");
  });

  it("falls through to fn() when eviction is unsupported", async () => {
    const ctx = {
      supportsEviction: false,
      memo: () => {
        throw new Error("memo must not be called on a degraded engine");
      },
    };
    const memoize = createMemoize(ctx);
    expect(await memoize(["k"], () => "fallback")).toBe("fallback");
  });
});
