import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSubstrateContract } from "../substrate/contract";
import { FAKE_SUBSTRATE_ID, FakeSubstrate } from "../substrate/fake";
import type { StackSpec } from "../substrate/types";
import { SubstrateError, SubstrateNotFoundError } from "../substrate/types";

/**
 * Two layers, on purpose:
 *  1. the shared contract — the behaviour `RailwaySubstrate` must match, run
 *     here against the fake so a change to the seam breaks in the cheap suite
 *     first;
 *  2. fake-ONLY affordances (`failNext`, the `calls` log). These are not part
 *     of the contract — no real substrate can be told to fail — but the rest of
 *     PRD 04 leans on them to prove retry and idempotency, so they get tested
 *     as the tools they are.
 */

describeSubstrateContract("FakeSubstrate", () => {
  const fake = new FakeSubstrate();
  return { provider: fake, inspect: async (refs) => fake.snapshot(refs) };
});

const SPEC: StackSpec = {
  stackId: "33333333-3333-4333-8333-333333333333",
  organizationId: "44444444-4444-4444-8444-444444444444",
  environmentName: "staging",
  region: "eu",
  topology: "dedicated",
  initialImage: "hogsend-default:0.55.0",
  env: { LOG_LEVEL: "info" },
};

describe("FakeSubstrate specifics", () => {
  it("issues a deterministic api URL derived from the stack id", async () => {
    const a = await new FakeSubstrate().provisionStack(SPEC);
    const b = await new FakeSubstrate().provisionStack(SPEC);

    expect(a.apiPublicUrl).toBe(`http://fake.${SPEC.stackId}.localhost`);
    expect(b).toEqual(a);
    expect(a.substrate).toBe(FAKE_SUBSTRATE_ID);
  });

  it("failNext injects exactly one failure, then behaves normally", async () => {
    const fake = new FakeSubstrate();
    fake.failNext("provisionStack");

    const error = await fake
      .provisionStack(SPEC)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SubstrateError);
    // Default is RETRYABLE: the interesting case for the pipeline's backoff.
    expect((error as SubstrateError).retryable).toBe(true);

    // The failed attempt left NO stack behind, so the retry is a clean first
    // provision rather than a resume of half-built state.
    const refs = await fake.provisionStack(SPEC);
    expect(refs.apiPublicUrl).toContain(SPEC.stackId);
    expect((await fake.getHealth(refs)).healthy).toBe(true);
  });

  it("queues consecutive scripted failures and honours a permanent one", async () => {
    const fake = new FakeSubstrate();
    const refs = await fake.provisionStack(SPEC);
    fake.failNext("setEnv");
    fake.failNext("setEnv", new SubstrateError("permanent", {}));

    await expect(fake.setEnv(refs, { A: "1" })).rejects.toMatchObject({
      retryable: true,
    });
    await expect(fake.setEnv(refs, { A: "1" })).rejects.toMatchObject({
      retryable: false,
    });
    await fake.setEnv(refs, { A: "1" });
    expect(fake.snapshot(refs).env.api.A).toBe("1");
  });

  it("records every call — including the ones that threw", async () => {
    const fake = new FakeSubstrate();
    fake.failNext("provisionStack");
    await fake.provisionStack(SPEC).catch(() => undefined);
    const refs = await fake.provisionStack(SPEC);
    await fake.setEnv(refs, { A: "1" });
    await fake.suspend(refs);

    expect(fake.calls.map((call) => call.method)).toEqual([
      "provisionStack",
      "provisionStack",
      "setEnv",
      "suspend",
    ]);
    expect(fake.calls[2]?.args[1]).toEqual({ A: "1" });
  });

  it("re-provisioning does not rebuild an existing stack's services", async () => {
    const fake = new FakeSubstrate();
    const refs = await fake.provisionStack(SPEC);
    await fake.deployImage(refs, {
      imageUrl: "ghcr.io/acme/app:sha",
      service: "api",
    });

    await fake.provisionStack(SPEC);

    // Idempotency the strong way: the customer's deployed image survives a
    // re-run of the provisioning step.
    expect(fake.snapshot(refs).services.api.image).toBe("ghcr.io/acme/app:sha");
  });

  it("setUnhealthy makes a running stack report sick, with a detail", async () => {
    const fake = new FakeSubstrate();
    const refs = await fake.provisionStack(SPEC);

    fake.setUnhealthy(refs);
    expect(await fake.getHealth(refs)).toEqual({
      healthy: false,
      detail: "stack was marked unhealthy",
    });

    fake.setUnhealthy(refs, false);
    expect((await fake.getHealth(refs)).healthy).toBe(true);
  });

  it("verifies an attached domain on demand and refuses an unknown one", () => {
    const fake = new FakeSubstrate();
    return fake.provisionStack(SPEC).then(async (refs) => {
      await fake.attachDomain(refs, "app.acme.test");
      fake.verifyDomain(refs, "app.acme.test");
      expect(await fake.attachDomain(refs, "app.acme.test")).toMatchObject({
        status: "verified",
      });
      expect(() => fake.verifyDomain(refs, "other.acme.test")).toThrow(
        SubstrateNotFoundError,
      );
    });
  });

  it("refuses refs that never came from it", async () => {
    const fake = new FakeSubstrate();
    const foreign = {
      substrate: "railway",
      apiPublicUrl: "https://example.test",
      data: {},
    };

    await expect(fake.getHealth(foreign)).rejects.toBeInstanceOf(
      SubstrateNotFoundError,
    );
  });

  it("reset clears both state and the call log", async () => {
    const fake = new FakeSubstrate();
    const refs = await fake.provisionStack(SPEC);

    fake.reset();

    expect(fake.calls).toHaveLength(0);
    await expect(fake.getHealth(refs)).rejects.toBeInstanceOf(
      SubstrateNotFoundError,
    );
  });
});

/**
 * The factory is the fail-closed boundary (PRD 04 EARS: "`CLOUD_SUBSTRATE`
 * =railway with no token configured SHALL fail closed with a clear error, never
 * silently fake"). Each case re-imports the module under a stubbed env, because
 * both `env` and the fake singleton are module state.
 */
describe("getSubstrate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadFactory(substrate: string, token?: string) {
    vi.resetModules();
    vi.stubEnv("CLOUD_SUBSTRATE", substrate);
    vi.stubEnv("CLOUD_RAILWAY_TOKEN", token ?? "");
    return import("../substrate/index");
  }

  it("defaults to a fake, and returns the SAME one every call", async () => {
    const { getSubstrate, FakeSubstrate: Fake } = await loadFactory("fake");

    const first = getSubstrate();
    expect(first).toBeInstanceOf(Fake);
    // In-memory state would vanish between requests otherwise.
    expect(getSubstrate()).toBe(first);
  });

  it("refuses railway without a token, naming the missing var", async () => {
    // The reloaded module has its own class identity, so assert against ITS
    // `SubstrateError` rather than the statically imported one.
    const { getSubstrate, SubstrateError: Err } = await loadFactory("railway");

    expect(() => getSubstrate()).toThrow(Err);
    expect(() => getSubstrate()).toThrow(/CLOUD_RAILWAY_TOKEN/);
    // It must never hand back a substrate instead.
    expect(getSubstrate).toThrow();
  });

  it("refuses railway even WITH a token — not implemented yet", async () => {
    const { getSubstrate } = await loadFactory("railway", "fake-railway-token");

    expect(() => getSubstrate()).toThrow(/not implemented yet/);
  });

  it("rejects an unknown substrate name at boot", async () => {
    await expect(loadFactory("gcp")).rejects.toThrow();
  });
});
