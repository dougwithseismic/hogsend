import { describe, expect, it } from "vitest";
import {
  HatchetTenantError,
  HatchetTenantService,
} from "../services/hatchet-tenant";

/**
 * The live leg runs against the repo's docker-compose hatchet-lite (dashboard
 * on 8888), whose seeded admin is the dev default in `env.ts`.
 *
 * When that instance is not up the live leg SKIPS — but LOUDLY. A silently
 * green suite here would be worse than a red one: the whole point of this file
 * is that the ported register → ensure-tenant → mint flow still matches the
 * real Hatchet API, and only a live run can say so.
 */
const HATCHET_URL =
  process.env.CLOUD_TEST_HATCHET_URL ?? "http://localhost:8888";

/**
 * A STABLE slug, deliberately not randomised: Hatchet tenants cannot be
 * deleted through the API, so a per-run slug would litter the dev instance
 * forever. Reusing one slug also means every run after the first exercises the
 * "tenant already exists" branch for real.
 */
const TEST_TENANT_SLUG = "hogsend-cloud-provision-test";

const service = new HatchetTenantService();

async function hatchetReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${HATCHET_URL}/api/v1/meta`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await hatchetReachable();

if (!reachable) {
  console.warn(
    [
      "",
      "############################################################",
      "# SKIPPED: hatchet-tenant live tests                       #",
      "############################################################",
      `# No Hatchet answered ${HATCHET_URL}/api/v1/meta within 2s.`,
      "# The register → ensure-tenant → mint-token flow is",
      "# THEREFORE UNVERIFIED in this run.",
      "# Start it with:  docker compose up -d hatchet-lite",
      "# Or point elsewhere with CLOUD_TEST_HATCHET_URL.",
      "############################################################",
      "",
    ].join("\n"),
  );
}

describe("HatchetTenantService input guards", () => {
  // Pure unit — always run.
  it("rejects a non-http url", async () => {
    await expect(
      service.mintToken({ hatchetUrl: "localhost:8888", tenantSlug: "abc" }),
    ).rejects.toBeInstanceOf(HatchetTenantError);
  });

  it("rejects a slug Hatchet would not accept", async () => {
    for (const slug of ["", "Bad_Slug", "-lead", "trail-", "a b"]) {
      await expect(
        service.mintToken({ hatchetUrl: HATCHET_URL, tenantSlug: slug }),
      ).rejects.toBeInstanceOf(HatchetTenantError);
    }
  });

  it("fails closed when no admin credentials are configured", async () => {
    await expect(
      service.mintToken({
        hatchetUrl: HATCHET_URL,
        tenantSlug: "abc",
        adminEmail: "",
        adminPassword: "",
      }),
    ).rejects.toBeInstanceOf(HatchetTenantError);
  });
});

describe.skipIf(!reachable)("HatchetTenantService against live hatchet", () => {
  it("mints a JWT-shaped token and is idempotent on the tenant", async () => {
    const first = await service.mintToken({
      hatchetUrl: HATCHET_URL,
      tenantSlug: TEST_TENANT_SLUG,
    });

    expect(first.tenantSlug).toBe(TEST_TENANT_SLUG);
    expect(first.tenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.token.split(".")).toHaveLength(3);

    const second = await service.mintToken({
      hatchetUrl: HATCHET_URL,
      tenantSlug: TEST_TENANT_SLUG,
    });

    // Same tenant reused; tokens are additive, so a fresh one is expected.
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.createdTenant).toBe(false);
    expect(second.token.split(".")).toHaveLength(3);
    expect(second.token).not.toBe(first.token);
  });
});
