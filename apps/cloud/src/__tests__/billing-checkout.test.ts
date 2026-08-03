import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as CHECKOUT } from "../../app/api/billing/checkout/route";
import { POST as PORTAL } from "../../app/api/billing/portal/route";
import { getFakeBilling } from "../billing";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, organizations } from "../db/schema";
import { organization, user } from "../db/schema/auth";
import { env } from "../env";
import { auth } from "../lib/auth";
import { BILLING_NOTICES } from "../lib/billing-notice";
import { provisionOrganization } from "../lib/org-provision";

/**
 * The upgrade surface, as the HTTP endpoints a form actually posts to.
 *
 * `/api` is excluded from the proxy's matcher (`proxy.ts`), which is right for
 * the provider webhook and WRONG to inherit here: these two routes start a paid
 * checkout and open a billing portal for a named organization, so each resolves
 * the session itself. That is the rule this suite exists to pin — a regression
 * would be an endpoint anyone on the internet could aim at any tenant id.
 *
 * The provider is the process-wide `FakeBilling` (`CLOUD_BILLING` defaults to
 * it), so the assertions are about what the ROUTE asked for, not about Stripe.
 */

const PASSWORD = "correct-horse-8";
const OWNER = "checkout-test-owner@hogsend.test";
const MEMBER = "checkout-test-member@hogsend.test";
const EMAILS = [OWNER, MEMBER];
const CELL = "checkout-test-us-1";
const ORG_PREFIX = "CheckoutTest";

const fake = getFakeBilling();

let organizationId = "";

const CHECKOUT_URL = "http://localhost:3004/api/billing/checkout";
const PORTAL_URL = "http://localhost:3004/api/billing/portal";

/** A `cookie` header carrying a real signed-in session. */
async function signIn(email: string): Promise<string> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error(`sign-in returned no cookie for ${email}`);
  return cookie;
}

function post(
  url: string,
  fields: Record<string, string>,
  cookie?: string,
): Request {
  const body = new URLSearchParams(fields);
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
  });
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, EMAILS));
  await db.delete(cells).where(eq(cells.name, CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of EMAILS) {
    await auth.api.signUpEmail({
      body: { name: email.split("@")[0] as string, email, password: PASSWORD },
    });
  }
  await db.insert(cells).values({
    name: CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  const provisioned = await provisionOrganization({
    name: `${ORG_PREFIX} Alpha`,
    region: "us",
    headers: new Headers({ cookie: await signIn(OWNER) }),
  });
  organizationId = provisioned.organizationId;
});

beforeEach(() => {
  fake.reset();
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("POST /api/billing/checkout", () => {
  it("creates a checkout for the caller's own organization and redirects", async () => {
    const response = await CHECKOUT(
      post(CHECKOUT_URL, { plan: "self_serve" }, await signIn(OWNER)),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `http://fake-billing.localhost/checkout/${encodeURIComponent(
        organizationId,
      )}/self_serve`,
    );
    expect(fake.checkouts).toEqual([
      {
        organizationId,
        plan: "self_serve",
        successUrl: expect.stringContaining("/usage"),
        cancelUrl: expect.stringContaining("/usage"),
      },
    ]);
  });

  it("takes the organization from the SESSION, never from the request", async () => {
    // The obvious attack on a billing endpoint: name someone else's tenant.
    const response = await CHECKOUT(
      post(
        CHECKOUT_URL,
        { plan: "self_serve", organizationId: "someone-elses-org" },
        await signIn(OWNER),
      ),
    );

    expect(response.status).toBe(303);
    expect(fake.checkouts[0]?.organizationId).toBe(organizationId);
  });

  it("sends an unauthenticated caller to sign in, and creates nothing", async () => {
    const response = await CHECKOUT(post(CHECKOUT_URL, { plan: "self_serve" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
    expect(fake.checkouts).toHaveLength(0);
  });

  it("refuses a plan this control plane does not sell", async () => {
    const response = await CHECKOUT(
      post(CHECKOUT_URL, { plan: "trial" }, await signIn(OWNER)),
    );

    expect(response.headers.get("location")).toContain("billing=invalid_plan");
    expect(fake.checkouts).toHaveLength(0);
  });

  it("answers an unconfigured provider with a notice, not a crash", async () => {
    fake.failNext("createCheckout");

    const response = await CHECKOUT(
      post(CHECKOUT_URL, { plan: "dedicated" }, await signIn(OWNER)),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("billing=unavailable");
  });
});

describe("POST /api/billing/portal", () => {
  it("opens the provider's portal for the caller's organization", async () => {
    const response = await PORTAL(post(PORTAL_URL, {}, await signIn(OWNER)));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `http://fake-billing.localhost/portal/${encodeURIComponent(
        organizationId,
      )}`,
    );
  });

  it("sends an unauthenticated caller to sign in", async () => {
    const response = await PORTAL(post(PORTAL_URL, {}));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
    expect(
      fake.calls.filter((call) => call.method === "getPortalUrl"),
    ).toHaveLength(0);
  });
});

describe("billing notices", () => {
  it("declares a sentence for every code the routes can emit", () => {
    // The routes redirect with a CODE; a code with no sentence would render as
    // a silent no-op page after a failed upgrade.
    for (const code of [
      "disabled",
      "unavailable",
      "forbidden",
      "invalid_plan",
      "cancelled",
    ] as const) {
      expect(BILLING_NOTICES[code].length).toBeGreaterThan(0);
    }
  });
});
