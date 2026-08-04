import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  environments,
  hostnames,
  organizations,
  stacks,
} from "../db/schema";
import {
  organization as authOrganization,
  member,
  user,
} from "../db/schema/auth";
import { DnsError, type DnsProvider, FakeDns } from "../dns";
import { env } from "../env";
import { encryptSecretPayload } from "../lib/crypto";
import { readStackRefs } from "../lib/stack-refs";
import { runProvisionPipeline } from "../pipeline/provision";
import type { HatchetTenantService } from "../services/hatchet-tenant";
import { FakeSubstrate } from "../substrate";

/**
 * The `ensure-hostname` step: the one that decides what an instance is called
 * for the rest of its life.
 *
 * The assertions worth having are about the ORDER and the FALLBACK, not the
 * string. `API_PUBLIC_URL` is frozen at `set-env` and mints every tracked link
 * thereafter, so a hostname that lands one step late is a hostname that never
 * takes effect — and a DNS outage that fails a signup is a worse outcome than
 * an instance on the substrate's own URL.
 */

const ORG_ID = "provision-hostname-test-org";
/** The cell's admin cluster, not the control-plane database. */
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";
const CELL_NAME = "provision-hostname-cell";
const ZONE = "hogsend-tenants.test";
const SLUG = "acmehostname";
const OWNER_ID = "provision-hostname-owner";
const OWNER_EMAIL = "hostname-owner@local.test";

const createdDatabases: string[] = [];

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG_ID]));
  await db
    .delete(authOrganization)
    .where(inArray(authOrganization.id, [ORG_ID]));
  await db.delete(member).where(inArray(member.organizationId, [ORG_ID]));
  await db.delete(user).where(inArray(user.id, [OWNER_ID]));
  await db.delete(cells).where(inArray(cells.name, [CELL_NAME]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  const [cell] = await db
    .insert(cells)
    .values({
      name: CELL_NAME,
      region: "us",
      sharedClusterDsn: encryptSecretPayload(CLUSTER_DSN),
      sharedHatchetUrl: "http://hatchet.hostname.test:8888",
      accepting: true,
    })
    .returning();

  // Better Auth's row is where the slug lives, and where the pipeline reads it.
  await db.insert(authOrganization).values({
    id: ORG_ID,
    name: "Acme Hostname",
    slug: SLUG,
    createdAt: new Date(),
  });
  await db.insert(organizations).values({
    id: ORG_ID,
    name: "Acme Hostname",
    region: "us",
    plan: "trial",
    cellId: cell?.id ?? null,
  });

  // `mint-credentials` makes the org OWNER the tenant's Studio admin, so the
  // membership is part of a provisionable fixture, not decoration.
  await db.insert(user).values({
    id: OWNER_ID,
    name: "Hostname Owner",
    email: OWNER_EMAIL,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(member).values({
    id: `${OWNER_ID}-member`,
    organizationId: ORG_ID,
    userId: OWNER_ID,
    role: "owner",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

async function seedStack(
  kind: "production" | "staging",
): Promise<{ stackId: string; environmentId: string }> {
  const name = kind === "production" ? "production" : "staging";
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG_ID,
      name: `${name}-${randomBytes(2).toString("hex")}`,
      kind,
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const dbName = `t_host_${randomBytes(5).toString("hex")}`;
  createdDatabases.push(dbName);
  await db.insert(stacks).values({
    id: stackId,
    organizationId: ORG_ID,
    environmentId: environment.id,
    status: "requested",
    region: "us",
    hatchetNamespace: stackId,
    dbName,
  });
  return { stackId, environmentId: environment.id };
}

/** No real Hatchet in a unit test; the token's value is irrelevant here. */
function stubHatchet(): HatchetTenantService {
  return {
    async mintToken() {
      return { token: "hostname-test-token" };
    },
  } as unknown as HatchetTenantService;
}

function deps(
  dns: DnsProvider,
  zone: string | null = ZONE,
  ssoCookieDomain: string | null = null,
) {
  return {
    substrate: new FakeSubstrate(),
    dns,
    hostnameZone: zone,
    ssoCookieDomain,
    hatchetTenant: stubHatchet(),
  };
}

describe("ensure-hostname", () => {
  it("gives the instance its hostname before the env freezes it", async () => {
    const fixture = await seedStack("production");
    const dns = new FakeDns();
    const substrate = new FakeSubstrate();

    const run = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { ...deps(dns), substrate },
    );

    expect(run.status).toBe("running");

    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    const refs = readStackRefs(stack!);
    expect(refs?.apiPublicUrl).toMatch(
      new RegExp(`^https://[a-z0-9-]+\\.${ZONE.replace(".", "\\.")}$`),
    );

    // THE assertion, and the reason the step sits where it does: the env the
    // instance actually booted with carries the managed hostname. These two
    // variables mint every tracked link and sign the Studio cookie, so if the
    // step ever moved after `set-env` this is what would catch it — the refs
    // above would still be right while the running instance was not.
    const applied = substrate.snapshot(refs!);
    expect(applied.env.api.API_PUBLIC_URL).toBe(refs?.apiPublicUrl);
    expect(applied.env.api.BETTER_AUTH_URL).toBe(refs?.apiPublicUrl);
    expect(applied.env.api.API_PUBLIC_URL).toContain(ZONE);
  });

  it("records the hostname and the record id for teardown", async () => {
    const fixture = await seedStack("production");
    const dns = new FakeDns();

    await runProvisionPipeline({ stackId: fixture.stackId }, deps(dns));

    const rows = await db
      .select()
      .from(hostnames)
      .where(eq(hostnames.environmentId, fixture.environmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("managed");
    // BOTH records: a custom domain needs a CNAME to route and a TXT to verify,
    // and the platform 404s a domain whose TXT is missing. Without every id,
    // destroy would strand records in a zone with a hard cap.
    expect(rows[0]?.dnsRecordIds).toHaveLength(2);
  });

  it("suffixes a non-production environment as one label", async () => {
    const fixture = await seedStack("staging");
    const dns = new FakeDns();

    await runProvisionPipeline({ stackId: fixture.stackId }, deps(dns));

    const [row] = await db
      .select()
      .from(hostnames)
      .where(eq(hostnames.environmentId, fixture.environmentId));
    // One label before the zone — never a second DNS level.
    expect(row?.hostname.split(".")).toHaveLength(ZONE.split(".").length + 1);
    expect(row?.hostname.startsWith(`${SLUG}-`)).toBe(true);
  });

  // A re-driven run must not mint a second name or a second record.
  it("is idempotent across a re-drive", async () => {
    const fixture = await seedStack("production");
    const dns = new FakeDns();
    const shared = deps(dns);

    await runProvisionPipeline({ stackId: fixture.stackId }, shared);
    const first = await db
      .select()
      .from(hostnames)
      .where(eq(hostnames.environmentId, fixture.environmentId));

    await runProvisionPipeline({ stackId: fixture.stackId }, shared);
    const second = await db
      .select()
      .from(hostnames)
      .where(eq(hostnames.environmentId, fixture.environmentId));

    expect(second).toHaveLength(1);
    expect(second[0]?.hostname).toBe(first[0]?.hostname);
    // Two records for one hostname (CNAME + ownership TXT), and the re-drive
    // finds both rather than publishing a second pair — which would burn the
    // zone's record cap twice per retry.
    expect((await dns.readCapacity()).used).toBe(2);
    expect(second[0]?.dnsRecordIds).toHaveLength(2);
  });

  // The trade this step is built around: a name is an improvement to
  // provisioning, never a precondition for it.
  it("still provisions when DNS is down, keeping the substrate URL", async () => {
    const fixture = await seedStack("production");
    const broken: DnsProvider = {
      id: "broken",
      ensureRecord: async () => {
        throw new DnsError("zone unavailable", { retryable: true });
      },
      deleteRecord: async () => {},
      readCapacity: async () => ({ used: 0, limit: null }),
    };

    const run = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps(broken),
    );

    expect(run.status).toBe("running");
    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(readStackRefs(stack!)?.apiPublicUrl).not.toContain(ZONE);
    expect(
      await db
        .select()
        .from(hostnames)
        .where(eq(hostnames.environmentId, fixture.environmentId)),
    ).toHaveLength(0);
  });

  // The structural half of the cookie fix: even if someone configures a tenant
  // zone inside the SSO cookie's domain, no instance is ever named there.
  it("refuses to name an instance inside the SSO cookie domain", async () => {
    const fixture = await seedStack("production");
    const dns = new FakeDns();

    const run = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps(dns, "cloud.hogsend.com", ".hogsend.com"),
    );

    expect(run.status).toBe("running");
    expect(
      run.steps.find((step) => step.step === "ensure-hostname")?.skipped,
    ).toBe(true);
    // Nothing published, nothing recorded, instance stays on the substrate URL.
    expect((await dns.readCapacity()).used).toBe(0);
    expect(
      await db
        .select()
        .from(hostnames)
        .where(eq(hostnames.environmentId, fixture.environmentId)),
    ).toHaveLength(0);
  });

  // Every control plane deployed before this step existed is in this state.
  it("is a no-op with no zone configured", async () => {
    const fixture = await seedStack("production");
    const dns = new FakeDns();

    const run = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps(dns, null),
    );

    expect(run.status).toBe("running");
    expect(
      run.steps.find((step) => step.step === "ensure-hostname")?.skipped,
    ).toBe(true);
    expect((await dns.readCapacity()).used).toBe(0);
  });
});
