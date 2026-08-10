import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The two Hogsend Email credential variables (PRD 01 task 5, DECISIONS §7.1),
 * exercised the way a real boot reads them: re-import `src/env.ts` under a
 * stubbed `process.env` — the same harness `artifact-bucket-config.test.ts`
 * uses for the bucket group.
 *
 * What is pinned here is the POSTURE, not a guard: the pair is declared and
 * typed alongside every other cloud var, and it is optional, so a control
 * plane with no AWS account boots exactly as it does today and the SES factory
 * yields the Fake. The both-or-neither refusal deliberately lives at the point
 * of use in `src/ses/index.ts` (covered by `ses-factory.test.ts`), which is
 * why the half-a-pair case below BOOTS rather than throwing.
 */

const KEY = "CLOUD_AWS_ACCESS_KEY_ID";
const SECRET = "CLOUD_AWS_SECRET_ACCESS_KEY";

/** Nothing inherited from the developer's shell may decide these tests. */
function clearCredentials(): void {
  vi.stubEnv(KEY, undefined);
  vi.stubEnv(SECRET, undefined);
}

async function importEnv() {
  vi.resetModules();
  const { env } = await import("../env");
  return env;
}

describe("AWS control-plane credentials in the validated env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("parses with NEITHER set — the supported default, not a boot failure", async () => {
    clearCredentials();

    const env = await importEnv();

    expect(env[KEY]).toBeUndefined();
    expect(env[SECRET]).toBeUndefined();
  });

  it("parses with BOTH set, carrying them through as declared vars", async () => {
    clearCredentials();
    vi.stubEnv(KEY, "AKIAFAKEACCESSKEY");
    vi.stubEnv(SECRET, "fake-secret-access-key");

    const env = await importEnv();

    // An UNDECLARED variable would never reach the validated env object, so
    // reading the values back is what proves the pair is in the schema.
    expect(env[KEY]).toBe("AKIAFAKEACCESSKEY");
    expect(env[SECRET]).toBe("fake-secret-access-key");
  });

  // Half a pair is a misconfiguration, but env.ts is deliberately NOT where it
  // is refused: the throw belongs next to the choice it invalidates, in
  // `src/ses/index.ts`. Asserting the boot survives keeps that split honest —
  // if someone moves the guard here, this test says so.
  for (const present of [KEY, SECRET]) {
    it(`boots with only ${present} set — the refusal lives in src/ses/index.ts`, async () => {
      clearCredentials();
      vi.stubEnv(present, "half-a-pair");

      const env = await importEnv();

      expect(env[present as typeof KEY]).toBe("half-a-pair");
    });
  }

  it("treats an empty value as absent rather than as a failed min(1)", async () => {
    clearCredentials();
    vi.stubEnv(KEY, "");
    vi.stubEnv(SECRET, "");

    const env = await importEnv();

    // `emptyStringAsUndefined` — an unset Railway variable arrives as "" and
    // must read as "no credentials", exactly like the factory's trim.
    expect(env[KEY]).toBeUndefined();
    expect(env[SECRET]).toBeUndefined();
  });
});
