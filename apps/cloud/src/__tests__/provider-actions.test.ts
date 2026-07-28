import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The provider server actions, called the way a browser calls them: the REAL
 * action, a REAL signed-in session, the REAL control-plane database.
 *
 * Two seams, both for the reasons the rest of this suite uses them:
 *  - `next/headers` + `next/cache` are mocked, because a form action needs a
 *    request context that a unit test has none of. The action itself is NOT
 *    mocked — asserting that a dead key reaches the browser as a sentence is
 *    only worth doing against the thing the browser posts to.
 *  - `fetch` is stubbed BEFORE the modules import, so the default
 *    `KeySyncService` captures the fake rather than the real one. A validator
 *    suite that called api.resend.com would need a real credential in the repo
 *    and would go red whenever a vendor did. Anything that is not a provider
 *    endpoint falls through to the real fetch.
 *
 * Every credential below is an obvious fake.
 */

/** The header set `headers()` answers with inside the action calls. */
let actionHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: async () => actionHeaders }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const VERIFIED_DOMAIN = "acme.test";
const RESEND_KEY = "re_fake_action_key_1111";

/** Which answer the next provider probe gets. Flipped per test. */
let probeMode: "ok" | "refuse" = "ok";

const realFetch = globalThis.fetch;
const PROVIDER_HOSTS = [
  "api.resend.com",
  "api.postmarkapp.com",
  "api.twilio.com",
  "posthog.com",
];

vi.stubGlobal("fetch", (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = String(input);
  if (!PROVIDER_HOSTS.some((host) => url.includes(host))) {
    return realFetch(input, init);
  }
  if (probeMode === "refuse") {
    return new Response(JSON.stringify({ message: "invalid" }), {
      status: 401,
    });
  }
  if (url.includes("resend.com")) {
    return new Response(
      JSON.stringify({
        data: [{ name: VERIFIED_DOMAIN, status: "verified" }],
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch);

const {
  removeProviderKeyAction,
  saveProviderKeyAction,
  saveSenderIdentityAction,
} = await import("../../app/settings/provider-actions");

const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { cells, organizations, providerKeys } = await import("../db/schema");
const { member, organization, user } = await import("../db/schema/auth");
const { env } = await import("../env");
const { auth } = await import("../lib/auth");
const { provisionOrganization } = await import("../lib/org-provision");
const { EMPTY_ACTION_STATE } = await import("../lib/action-state");
const { SENDER_IDENTITY_PROVIDER } = await import("../services/provider-env");
const { eq, inArray, like } = await import("drizzle-orm");

const PASSWORD = "correct-horse-8";
const OWNER = "provider-actions-owner@hogsend.test";
const MEMBER = "provider-actions-member@hogsend.test";
const EMAILS = [OWNER, MEMBER];
const US_CELL = "provider-actions-test-us-1";
const ORG_PREFIX = "ProviderActionsTest";

async function signIn(email: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error(`sign-in returned no cookie for ${email}`);
  return new Headers({ cookie });
}

/** Act as `email` for the next action call. */
async function actAs(email: string): Promise<void> {
  actionHeaders = await signIn(email);
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

async function storedProviders(environmentId: string): Promise<string[]> {
  const rows = await db
    .select({ provider: providerKeys.provider })
    .from(providerKeys)
    .where(eq(providerKeys.environmentId, environmentId));
  return rows.map((row) => row.provider).sort();
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
  await db.delete(cells).where(eq(cells.name, US_CELL));
}

let environmentId = "";

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of EMAILS) {
    await auth.api.signUpEmail({
      body: { name: email.split("@")[0] as string, email, password: PASSWORD },
    });
  }

  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  const provisioned = await provisionOrganization(
    { name: `${ORG_PREFIX} Alpha`, region: "us", headers: await signIn(OWNER) },
    {
      // This suite's cell has a deliberately unusable DSN: what signup owes
      // here is the enqueue, not a real provisioning run.
      enqueueProvision: async () => {},
    },
  );
  environmentId = provisioned.environmentId;

  const memberUser = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, MEMBER));
  const memberId = memberUser[0]?.id;
  if (!memberId) throw new Error("fixture member user missing");
  await db.insert(member).values({
    id: `provider-actions-member-${provisioned.organizationId}`,
    organizationId: provisioned.organizationId,
    userId: memberId,
    role: "member",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
  vi.unstubAllGlobals();
});

describe("saveProviderKeyAction", () => {
  it("refuses a member, and stores nothing", async () => {
    probeMode = "ok";
    await actAs(MEMBER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "resend", apiKey: RESEND_KEY }),
    );

    expect(state.error).toBe(
      "Only an owner or admin can change provider credentials.",
    );
    expect(await storedProviders(environmentId)).toEqual([]);
  });

  it("refuses a missing required field before the provider is called", async () => {
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "resend" }),
    );

    expect(state.error).toBe("API key is required.");
    expect(await storedProviders(environmentId)).toEqual([]);
  });

  it("refuses a provider that has no form", async () => {
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "mailgun", apiKey: "x" }),
    );

    expect(state.error).toBe("That provider is not configurable here.");
  });

  it("surfaces a rejected key as a sentence, and stores nothing", async () => {
    probeMode = "refuse";
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "resend", apiKey: RESEND_KEY }),
    );

    expect(state.error).toBe(
      "Resend rejected that credential. Nothing was stored.",
    );
    expect(state.notice).toBeFalsy();
    // The slug itself never reaches a browser.
    expect(state.error).not.toContain("unauthorized");
    expect(await storedProviders(environmentId)).toEqual([]);
  });

  it("surfaces an unverified sending domain, and stores neither half", async () => {
    probeMode = "ok";
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({
        environmentId,
        provider: "resend",
        apiKey: RESEND_KEY,
        fromAddress: "hello@not-verified.test",
      }),
    );

    expect(state.error).toContain(
      "not-verified.test is not a verified sending domain",
    );
    expect(state.error).toContain("Nothing was stored.");
    expect(await storedProviders(environmentId)).toEqual([]);
  });

  it("stores a live key with its address, and says what happened", async () => {
    probeMode = "ok";
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({
        environmentId,
        provider: "resend",
        apiKey: RESEND_KEY,
        fromAddress: `lifecycle@${VERIFIED_DOMAIN}`,
        // Not a field the Resend form declares — it must be ignored, not
        // turned into an environment variable nobody reviewed.
        DATABASE_URL: "postgres://somewhere",
      }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toBe(
      "Resend key stored and checked live. The environment picks it up when its stack starts.",
    );
    expect(await storedProviders(environmentId)).toEqual([
      "resend",
      SENDER_IDENTITY_PROVIDER,
    ]);

    const [row] = await db
      .select({ last4: providerKeys.last4 })
      .from(providerKeys)
      .where(eq(providerKeys.provider, "resend"));
    expect(row?.last4).toBe(RESEND_KEY.slice(-4));
  });

  it("calls a PostHog project key shape-checked, never verified", async () => {
    probeMode = "ok";
    await actAs(OWNER);

    const state = await saveProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({
        environmentId,
        provider: "posthog",
        apiKey: "phc_fakeactionprojectkey01",
      }),
    );

    expect(state.notice).toBe(
      "PostHog key stored; its shape was checked, not the key itself. The environment picks it up when its stack starts.",
    );
    expect(state.notice).not.toContain("verified");
  });
});

describe("saveSenderIdentityAction", () => {
  it("refuses a blank address", async () => {
    await actAs(OWNER);

    const state = await saveSenderIdentityAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, fromAddress: "" }),
    );

    expect(state.error).toBe("Enter the address your instance sends from.");
  });

  it("re-checks the stored key and names the provider", async () => {
    probeMode = "ok";
    await actAs(OWNER);

    const state = await saveSenderIdentityAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, fromAddress: `changed@${VERIFIED_DOMAIN}` }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toBe(
      `Your instance now sends from changed@${VERIFIED_DOMAIN}, checked against Resend.`,
    );
  });

  it("refuses an unverified domain on this path too", async () => {
    probeMode = "ok";
    await actAs(OWNER);

    const state = await saveSenderIdentityAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, fromAddress: "hello@somewhere-else.test" }),
    );

    expect(state.error).toContain(
      "somewhere-else.test is not a verified sending domain",
    );
  });
});

describe("removeProviderKeyAction", () => {
  it("refuses a member", async () => {
    await actAs(MEMBER);

    const state = await removeProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "resend" }),
    );

    expect(state.error).toBe(
      "Only an owner or admin can change provider credentials.",
    );
    expect(await storedProviders(environmentId)).toContain("resend");
  });

  it("lists what goes inert, and takes the row with it", async () => {
    await actAs(OWNER);

    const state = await removeProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "resend" }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toContain(
      "Now inert: email sending (journeys, broadcasts, transactional); delivery and bounce webhooks.",
    );
    expect(await storedProviders(environmentId)).not.toContain("resend");
  });

  it("is honest when there was nothing to remove", async () => {
    await actAs(OWNER);

    const state = await removeProviderKeyAction(
      EMPTY_ACTION_STATE,
      form({ environmentId, provider: "twilio" }),
    );

    expect(state.error).toBeNull();
    expect(state.notice).toBe("There was no Twilio credential to remove.");
  });
});
