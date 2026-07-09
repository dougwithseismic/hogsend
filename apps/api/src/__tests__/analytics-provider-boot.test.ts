import { afterAll, describe, expect, it } from "vitest";

// The env var is read at engine-module load (t3-env parses `process.env` once),
// so it MUST be set BEFORE the first `import("@hogsend/engine")` below. Files run
// isolated (fresh module graph) so this parses `ANALYTICS_PROVIDER` for THIS
// file only; the `afterAll` delete keeps the global mutation from leaking into
// any later-running file that re-parses env.
process.env.ANALYTICS_PROVIDER = "posthogg"; // deliberate typo → resolves to no provider
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

afterAll(() => {
  // `delete` (not `= undefined`, which Node coerces to the STRING "undefined")
  // so a later-running file re-parses env with ANALYTICS_PROVIDER truly unset.
  delete process.env.ANALYTICS_PROVIDER;
});

describe("ANALYTICS_PROVIDER boot validation (symmetric with EMAIL_PROVIDER)", () => {
  it("throws at boot when ANALYTICS_PROVIDER (env) resolves to no registered provider", async () => {
    const { createHogsendClient } = await import("@hogsend/engine");
    // No POSTHOG_API_KEY in the vitest env, so nothing is registered under
    // "posthogg". An explicitly-SET env id that resolves to nothing must fail
    // loud rather than SILENTLY disabling analytics.
    let thrown: unknown;
    try {
      createHogsendClient();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /analytics provider .*is not registered/i,
    );
    // The message names the bad id (mirrors the email-provider block).
    expect((thrown as Error).message).toContain("posthogg");
  });
});
