import { describe, expect, it } from "vitest";
import {
  type StackRefs,
  type StackSpec,
  SubstrateError,
  SubstrateNotFoundError,
  type SubstrateProvider,
  type SubstrateService,
} from "./types";

/**
 * The implementation-agnostic contract every `SubstrateProvider` must pass.
 *
 * This suite is the real definition of the seam — the interface only fixes the
 * shapes, this fixes the BEHAVIOUR (merge-not-replace env, per-service deploys,
 * suspend flips health, destroy is final). `FakeSubstrate` and
 * `RailwaySubstrate` (PRD 04 task 5, against a mocked transport) run the exact
 * same assertions, which is what makes the fake a safe stand-in for every other
 * test in the control plane.
 *
 * ## Why a harness rather than a bare provider
 * `setEnv`/`deployImage` return void by design (a caller has no business
 * reading a vendor's env back through the seam), so the contract cannot assert
 * their effect through the interface alone. The harness supplies ONE extra
 * capability — `inspect`, an implementation-private read of stack state — used
 * only by tests. That keeps the production surface minimal while still letting
 * the contract prove the write actually landed.
 */

/** Observable stack state, for assertions only. Never used in production. */
export interface SubstrateStackSnapshot {
  services: Record<SubstrateService, { image: string; running: boolean }>;
  /** Effective environment, per service, after every merge/unset so far. */
  env: Record<SubstrateService, Record<string, string>>;
}

export interface SubstrateContractHarness {
  provider: SubstrateProvider;
  /** Read back what the substrate actually holds for these refs. */
  inspect(refs: StackRefs): Promise<SubstrateStackSnapshot>;
}

const SERVICES: SubstrateService[] = ["api", "worker"];

/** A fixed spec — no clock, no randomness, so failures are reproducible. */
function makeSpec(overrides: Partial<StackSpec> = {}): StackSpec {
  return {
    stackId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    environmentName: "production",
    region: "us",
    topology: "shared",
    initialImage: "hogsend-default:0.55.0",
    env: { DATABASE_URL: "postgres://tenant/db", LOG_LEVEL: "info" },
    ...overrides,
  };
}

/**
 * Register the contract suite for one implementation.
 *
 * @param name  Suite label, e.g. `"FakeSubstrate"`.
 * @param makeProvider  Builds a FRESH harness per test — no state may leak
 *   between cases, or an ordering bug hides behind a passing suite.
 */
export function describeSubstrateContract(
  name: string,
  makeProvider: () =>
    | SubstrateContractHarness
    | Promise<SubstrateContractHarness>,
): void {
  describe(`SubstrateProvider contract: ${name}`, () => {
    async function setup(spec: StackSpec = makeSpec()): Promise<{
      harness: SubstrateContractHarness;
      provider: SubstrateProvider;
      refs: StackRefs;
    }> {
      const harness = await makeProvider();
      const refs = await harness.provider.provisionStack(spec);
      return { harness, provider: harness.provider, refs };
    }

    it("provisions a stack whose refs carry a usable api public URL", async () => {
      const { refs } = await setup();

      expect(refs.substrate).toBeTruthy();
      // REQUIRED by the pipeline: it becomes API_PUBLIC_URL/BETTER_AUTH_URL.
      expect(refs.apiPublicUrl).toMatch(/^https?:\/\/.+/);
      expect(refs.apiPublicUrl.endsWith("/")).toBe(false);
      expect(refs.data).toBeTypeOf("object");
      // The handle must survive a round-trip through jsonb, since that is
      // exactly what `stacks.substrate_refs` does to it.
      expect(JSON.parse(JSON.stringify(refs))).toEqual(refs);
    });

    it("boots every service on the spec's initial image", async () => {
      const { harness, refs } = await setup();
      const snapshot = await harness.inspect(refs);

      for (const service of SERVICES) {
        expect(snapshot.services[service].image).toBe("hogsend-default:0.55.0");
        expect(snapshot.services[service].running).toBe(true);
        expect(snapshot.env[service].DATABASE_URL).toBe("postgres://tenant/db");
      }
    });

    it("is idempotent by stack id — re-provisioning returns the same stack", async () => {
      const spec = makeSpec();
      const { harness, provider, refs } = await setup(spec);

      const again = await provider.provisionStack(spec);

      expect(again.apiPublicUrl).toBe(refs.apiPublicUrl);
      expect((await harness.inspect(again)).services.api.image).toBe(
        spec.initialImage,
      );
    });

    it("merges env and unsets on null", async () => {
      const { harness, provider, refs } = await setup();

      await provider.setEnv(refs, {
        LOG_LEVEL: "debug", // overwrite
        HATCHET_TOKEN: "fake-token", // add
        DATABASE_URL: null, // unset
      });

      const snapshot = await harness.inspect(refs);
      for (const service of SERVICES) {
        // Caller-owned vars merge and unset; a substrate may ALSO seed
        // platform-owned vars at provision (Railway: REDIS_URL) which setEnv
        // must leave alone — hence subset, not exact, equality.
        expect(snapshot.env[service]).toMatchObject({
          LOG_LEVEL: "debug",
          HATCHET_TOKEN: "fake-token",
        });
        expect(snapshot.env[service]?.DATABASE_URL).toBeUndefined();
      }
    });

    it("tolerates unsetting a variable that was never set", async () => {
      const { harness, provider, refs } = await setup();

      await provider.setEnv(refs, { NEVER_SET: null });

      expect(await harness.inspect(refs)).toBeTruthy();
      expect((await harness.inspect(refs)).env.api.LOG_LEVEL).toBe("info");
    });

    it("deploys an image to exactly one service", async () => {
      const { harness, provider, refs } = await setup();

      await provider.deployImage(refs, {
        imageUrl: "ghcr.io/acme/app:sha-worker",
        service: "worker",
        preDeployCommand: "pnpm db:migrate",
      });

      const snapshot = await harness.inspect(refs);
      expect(snapshot.services.worker.image).toBe(
        "ghcr.io/acme/app:sha-worker",
      );
      // The whole reason the selector exists (PRD 08 deploys worker, then api).
      expect(snapshot.services.api.image).toBe("hogsend-default:0.55.0");
    });

    it("redeploys without changing the image, repeatedly and per service", async () => {
      const { harness, provider, refs } = await setup();

      await provider.redeploy(refs);
      await provider.redeploy(refs);
      await provider.redeploy(refs, { service: "api" });

      const snapshot = await harness.inspect(refs);
      for (const service of SERVICES) {
        expect(snapshot.services[service].image).toBe("hogsend-default:0.55.0");
        expect(snapshot.services[service].running).toBe(true);
      }
    });

    it("suspends to unhealthy and resumes to healthy", async () => {
      const { harness, provider, refs } = await setup();

      expect(await provider.getHealth(refs)).toMatchObject({ healthy: true });

      await provider.suspend(refs);
      const suspended = await provider.getHealth(refs);
      expect(suspended.healthy).toBe(false);
      expect(await provider.getHealth(refs, { service: "api" })).toMatchObject({
        healthy: false,
      });
      const stopped = await harness.inspect(refs);
      for (const service of SERVICES) {
        expect(stopped.services[service].running).toBe(false);
      }

      await provider.resume(refs);
      expect(await provider.getHealth(refs)).toMatchObject({ healthy: true });
      const running = await harness.inspect(refs);
      for (const service of SERVICES) {
        expect(running.services[service].running).toBe(true);
      }
    });

    it("suspend and resume are safe to repeat", async () => {
      const { provider, refs } = await setup();

      await provider.suspend(refs);
      await provider.suspend(refs);
      expect((await provider.getHealth(refs)).healthy).toBe(false);

      await provider.resume(refs);
      await provider.resume(refs);
      expect((await provider.getHealth(refs)).healthy).toBe(true);
    });

    it("attaches a domain as pending with the records to publish", async () => {
      const { provider, refs } = await setup();

      const attachment = await provider.attachDomain(refs, "app.acme.test");

      // NEVER assumed verified: the tenant has not published DNS yet.
      expect(attachment.status).toBe("pending");
      // At least a routing record AND an ownership record. A substrate that
      // returns only the CNAME leaves a domain that resolves and then 404s
      // forever, and a caller cannot tell the difference from a success.
      expect(attachment.records.length).toBeGreaterThanOrEqual(2);
      expect(attachment.records.map((record) => record.type)).toContain(
        "CNAME",
      );
      expect(attachment.records.map((record) => record.type)).toContain("TXT");
      for (const record of attachment.records) {
        // A DNS type, never a vendor enum — a provider is handed this verbatim.
        expect(record.type).toMatch(/^[A-Z]+$/);
        // FULLY QUALIFIED. A bare label writes a record outside the zone.
        expect(record.name).toContain(".");
        expect(record.value).toBeTruthy();
      }
    });

    it("re-reads an attached domain without changing it", async () => {
      const { provider, refs } = await setup();
      await provider.attachDomain(refs, "app.acme.test");

      const first = await provider.checkDomain(refs, "app.acme.test");
      const second = await provider.checkDomain(refs, "app.acme.test");

      // Side-effect free and stable: the pipeline POLLS this, so a read that
      // mutated or drifted would make the wait's own outcome unrepeatable.
      expect(first.status).toBe("pending");
      expect(second.status).toBe("pending");
      expect(second.records).toEqual(first.records);
    });

    it("does not report a fresh domain as verified", async () => {
      const { provider, refs } = await setup();
      await provider.attachDomain(refs, "app.acme.test");

      // The whole point of the wait. A substrate that ripens instantly would
      // let a caller that never polls pass, and then fail in production the
      // way the first live provision did.
      expect((await provider.checkDomain(refs, "app.acme.test")).status).toBe(
        "pending",
      );
    });

    it("reports an unattached domain as a not-found", async () => {
      const { provider, refs } = await setup();

      await expect(
        provider.checkDomain(refs, "never-attached.acme.test"),
      ).rejects.toBeInstanceOf(SubstrateNotFoundError);
    });

    it("makes destroy final — every later call is a not-found", async () => {
      const { provider, refs } = await setup();

      await provider.destroyStack(refs);

      const notFound = [
        () => provider.getHealth(refs),
        () => provider.setEnv(refs, { A: "1" }),
        () => provider.redeploy(refs),
        () =>
          provider.deployImage(refs, {
            imageUrl: "ghcr.io/acme/app:sha",
            service: "api",
          }),
        () => provider.attachDomain(refs, "app.acme.test"),
        () => provider.checkDomain(refs, "app.acme.test"),
        () => provider.suspend(refs),
        () => provider.resume(refs),
        () => provider.destroyStack(refs),
      ];
      for (const call of notFound) {
        await expect(call()).rejects.toBeInstanceOf(SubstrateNotFoundError);
      }
    });

    it("reports a not-found as a permanent (non-retryable) failure", async () => {
      const { provider, refs } = await setup();
      await provider.destroyStack(refs);

      const error = await provider.getHealth(refs).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubstrateError);
      expect((error as SubstrateError).retryable).toBe(false);
    });
  });
}
