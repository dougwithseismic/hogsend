import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, environments, organizations, providerKeys } from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import { NotPermittedError } from "../lib/org-members";
import { provisionOrganization } from "../lib/org-provision";
import { describeRejection, proofOf } from "../lib/provider-catalog";
import {
  canManageProviderKeys,
  NoEmailProviderError,
  type ProviderKeysDeps,
  readProvidersView,
  removeProviderKey,
  saveProviderKey,
  saveSenderIdentity,
} from "../lib/provider-keys-ops";
import { NotFoundError } from "../services/errors";
import { KeySyncService } from "../services/key-sync";
import { SENDER_IDENTITY_PROVIDER } from "../services/provider-env";
import { ProviderKeyService } from "../services/provider-keys";

/**
 * The providers surface, against the REAL database and the REAL Better Auth
 * instance — the layer the server actions are a form-parser over.
 *
 * Why here and not through the action: `app/settings/provider-actions.ts` calls
 * `next/headers`, which needs a request context, and its dependencies are the
 * process-wide defaults — a test through it would reach api.resend.com with a
 * fake key. The RULES all live in `lib/provider-keys-ops.ts`, which takes a
 * real session header and injectable dependencies, so that is where they are
 * proven. The adapter above it is covered in `provider-actions.test.ts`.
 *
 * Two things are faked, for the reasons they are faked everywhere in this app:
 * the provisioning ENQUEUE (this suite's cell has an unusable DSN) and FETCH —
 * a validator suite that called a vendor would need a real credential in the
 * repo and would go red whenever that vendor did.
 */

const PASSWORD = "correct-horse-8";
const OWNER = "provider-settings-owner@hogsend.test";
const MEMBER = "provider-settings-member@hogsend.test";
const OUTSIDER = "provider-settings-outsider@hogsend.test";
const EMAILS = [OWNER, MEMBER, OUTSIDER];

const US_CELL = "provider-settings-test-us-1";
const ORG_PREFIX = "ProviderSettingsTest";

/** Obvious fakes. Nothing here resembles a real credential. */
const RESEND_KEY = "re_fake_settings_key_1111";
const POSTHOG_PROJECT_KEY = "phc_fakesettingsprojectkey01";
const POSTHOG_PERSONAL_KEY = "phx_fake_settings_personal_2222";
const VERIFIED_DOMAIN = "acme.test";

const sent: EmailMessage[] = [];
const spySender: EmailSender = {
  id: "spy",
  async send(message) {
    sent.push(message);
  },
};

const auth = createCloudAuth({ emailSender: spySender });
const providerKeyService = new ProviderKeyService(db);

/** A fetch that answers every validator with "live, one verified domain". */
function okFetch(domains: string[] = [VERIFIED_DOMAIN]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("resend.com")) {
      return new Response(
        JSON.stringify({
          data: domains.map((name) => ({ name, status: "verified" })),
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

/** A fetch that refuses everything — "the tenant pasted a dead key". */
const refusingFetch = (async () =>
  new Response(JSON.stringify({ message: "invalid" }), {
    status: 401,
  })) as typeof fetch;

/** Ops dependencies bound to a given probe answer. Never touches a vendor. */
function deps(fetchImpl: typeof fetch = okFetch()): ProviderKeysDeps {
  return {
    auth,
    db,
    providerKeys: providerKeyService,
    keySync: new KeySyncService({
      db,
      fetchImpl,
      providerKeys: providerKeyService,
    }),
  };
}

/** A `cookie` header carrying a real signed-in session for `email`. */
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

/** Every provider-key row for one environment, provider → last4. */
async function storedProviders(environmentId: string): Promise<string[]> {
  const rows = await db
    .select({ provider: providerKeys.provider })
    .from(providerKeys)
    .where(eq(providerKeys.environmentId, environmentId));
  return rows.map((row) => row.provider).sort();
}

let ownerOrgId = "";
let ownerEnvironmentId = "";
let outsiderEnvironmentId = "";

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

  const enqueued: string[] = [];
  const provisionDeps = {
    auth,
    enqueueProvision: async (stackId: string) => {
      enqueued.push(stackId);
    },
  };

  const owned = await provisionOrganization(
    { name: `${ORG_PREFIX} Alpha`, region: "us", headers: await signIn(OWNER) },
    provisionDeps,
  );
  ownerOrgId = owned.organizationId;
  ownerEnvironmentId = owned.environmentId;

  // A SECOND organization nobody in the first belongs to — the tenancy scope.
  const other = await provisionOrganization(
    {
      name: `${ORG_PREFIX} Beta`,
      region: "us",
      headers: await signIn(OUTSIDER),
    },
    provisionDeps,
  );
  outsiderEnvironmentId = other.environmentId;

  // MEMBER joins the first organization with the lowest role.
  const memberUser = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, MEMBER));
  const memberId = memberUser[0]?.id;
  if (!memberId) throw new Error("fixture member user missing");
  await db.insert(member).values({
    id: `provider-settings-member-${ownerOrgId}`,
    organizationId: ownerOrgId,
    userId: memberId,
    role: "member",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("role predicate", () => {
  it("counts owner and admin, and splits a multi-role", () => {
    expect(canManageProviderKeys("owner")).toBe(true);
    expect(canManageProviderKeys("admin")).toBe(true);
    expect(canManageProviderKeys("member")).toBe(false);
    expect(canManageProviderKeys("member,admin")).toBe(true);
    expect(canManageProviderKeys(null)).toBe(false);
  });
});

describe("who may change a credential", () => {
  it("refuses a member, and stores nothing", async () => {
    const headers = await signIn(MEMBER);
    const before = await storedProviders(ownerEnvironmentId);

    await expect(
      saveProviderKey(
        headers,
        {
          environmentId: ownerEnvironmentId,
          provider: "resend",
          payload: { apiKey: RESEND_KEY },
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);

    await expect(
      removeProviderKey(
        headers,
        { environmentId: ownerEnvironmentId, provider: "resend" },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);

    expect(await storedProviders(ownerEnvironmentId)).toEqual(before);
  });

  it("lets a member READ the surface, without a control", async () => {
    const view = await readProvidersView(await signIn(MEMBER), {}, deps());
    expect(view.canManage).toBe(false);
    expect(view.providers.map(({ form }) => form.id)).toEqual([
      "resend",
      "postmark",
      "posthog",
      "twilio",
    ]);
  });

  it("refuses an environment in another organization as not found", async () => {
    await expect(
      saveProviderKey(
        await signIn(OWNER),
        {
          environmentId: outsiderEnvironmentId,
          provider: "resend",
          payload: { apiKey: RESEND_KEY },
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await storedProviders(outsiderEnvironmentId)).toEqual([]);
  });
});

describe("saving a key", () => {
  it("stores nothing when the provider refuses the key", async () => {
    const result = await saveProviderKey(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        provider: "resend",
        payload: { apiKey: RESEND_KEY },
      },
      deps(refusingFetch),
    );

    expect(result.stored).toBe(false);
    if (result.stored) throw new Error("unreachable");
    expect(result.reason).toBe("invalid_key");
    expect(result.detail).toBe("unauthorized");
    // The sentence a form prints — the slug never reaches a tenant bare.
    expect(
      describeRejection({
        reason: result.reason,
        detail: result.detail,
        provider: "resend",
      }),
    ).toBe("Resend rejected that credential. Nothing was stored.");
    expect(await storedProviders(ownerEnvironmentId)).toEqual([]);
  });

  it("refuses a from-address whose domain is not verified, storing nothing", async () => {
    const result = await saveProviderKey(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        provider: "resend",
        payload: { apiKey: RESEND_KEY },
        fromAddress: "hello@not-verified.test",
      },
      deps(okFetch([VERIFIED_DOMAIN])),
    );

    expect(result.stored).toBe(false);
    if (result.stored) throw new Error("unreachable");
    expect(result.reason).toBe("from_domain_unverified");
    expect(result.detail).toBe("not-verified.test");
    expect(
      describeRejection({
        reason: result.reason,
        detail: result.detail,
        provider: "resend",
      }),
    ).toContain("not-verified.test is not a verified sending domain");
    // The KEY is refused with the address: one submission is one unit.
    expect(await storedProviders(ownerEnvironmentId)).toEqual([]);
  });

  it("stores a live key with its sending address, and syncs nothing yet", async () => {
    const result = await saveProviderKey(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        provider: "resend",
        payload: { apiKey: RESEND_KEY },
        fromAddress: `lifecycle@${VERIFIED_DOMAIN}`,
      },
      deps(),
    );

    expect(result.stored).toBe(true);
    if (!result.stored) throw new Error("unreachable");
    expect(result.key.last4).toBe(RESEND_KEY.slice(-4));
    expect(result.key.verifiedAt).not.toBeNull();
    // The stack is still `requested`, so nothing was pushed to a substrate —
    // the provisioning pipeline reads the same store on its way up.
    expect(result.synced).toBe(false);

    expect(await storedProviders(ownerEnvironmentId)).toEqual([
      "resend",
      SENDER_IDENTITY_PROVIDER,
    ]);

    const view = await readProvidersView(await signIn(OWNER), {}, deps());
    const resend = view.providers.find(({ form }) => form.id === "resend");
    expect(resend?.state.proof).toBe("live");
    expect(resend?.state.last4).toBe(RESEND_KEY.slice(-4));
    expect(view.sender.proof).toBe("live");
    expect(view.sender.checkedBy).toBe("resend");
  });

  it("calls a PostHog project key shape-checked, never verified", async () => {
    await saveProviderKey(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        provider: "posthog",
        payload: { apiKey: POSTHOG_PROJECT_KEY },
      },
      deps(),
    );

    const view = await readProvidersView(await signIn(OWNER), {}, deps());
    const posthog = view.providers.find(({ form }) => form.id === "posthog");
    expect(posthog?.state.configured).toBe(true);
    expect(posthog?.state.proof).toBe("shape_only");

    // …and live once the PERSONAL key (the one with a read endpoint) is added.
    await saveProviderKey(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        provider: "posthog",
        payload: {
          apiKey: POSTHOG_PROJECT_KEY,
          personalApiKey: POSTHOG_PERSONAL_KEY,
        },
      },
      deps(),
    );

    const after = await readProvidersView(await signIn(OWNER), {}, deps());
    expect(
      after.providers.find(({ form }) => form.id === "posthog")?.state.proof,
    ).toBe("live");
  });
});

describe("the sending address on its own", () => {
  it("re-checks the stored key and its domains", async () => {
    const result = await saveSenderIdentity(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        fromAddress: `changed@${VERIFIED_DOMAIN}`,
      },
      deps(),
    );

    expect(result.provider).toBe("resend");
    expect(result.stored).toBe(true);

    const view = await readProvidersView(await signIn(OWNER), {}, deps());
    expect(view.sender.configured).toBe(true);
    expect(view.sender.last4).toBe(VERIFIED_DOMAIN.slice(-4));
  });

  it("refuses an unverified domain through this path too", async () => {
    const result = await saveSenderIdentity(
      await signIn(OWNER),
      {
        environmentId: ownerEnvironmentId,
        fromAddress: "hello@somewhere-else.test",
      },
      deps(),
    );

    expect(result.stored).toBe(false);
    if (result.stored) throw new Error("unreachable");
    expect(result.reason).toBe("from_domain_unverified");
  });
});

describe("removing a credential", () => {
  it("names what goes inert, and takes the row with it", async () => {
    const result = await removeProviderKey(
      await signIn(OWNER),
      { environmentId: ownerEnvironmentId, provider: "resend" },
      deps(),
    );

    expect(result.removed).toBe(true);
    expect(result.inert).toContain(
      "email sending (journeys, broadcasts, transactional)",
    );
    expect(await storedProviders(ownerEnvironmentId)).not.toContain("resend");
  });

  it("is not an error when there was nothing to remove", async () => {
    const result = await removeProviderKey(
      await signIn(OWNER),
      { environmentId: ownerEnvironmentId, provider: "twilio" },
      deps(),
    );
    expect(result.removed).toBe(false);
    expect(result.inert).toContain("SMS sending");
  });

  it("refuses a sending address with no email provider left to check it", async () => {
    // `resend` was removed above; nothing is left to validate a domain against.
    await expect(
      saveSenderIdentity(
        await signIn(OWNER),
        {
          environmentId: ownerEnvironmentId,
          fromAddress: `lifecycle@${VERIFIED_DOMAIN}`,
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(NoEmailProviderError);
  });
});

describe("proof derivation", () => {
  it("never calls an unproven credential verified", () => {
    expect(
      proofOf({ provider: "resend", verifiedAt: null, fieldsPresent: [] }),
    ).toBe("unproven");
    expect(
      proofOf({
        provider: "resend",
        verifiedAt: new Date(),
        fieldsPresent: ["apiKey"],
      }),
    ).toBe("live");
    // A PostHog project key alone is shape-checked even with a verified stamp.
    expect(
      proofOf({
        provider: "posthog",
        verifiedAt: new Date(),
        fieldsPresent: ["apiKey"],
      }),
    ).toBe("shape_only");
  });
});

describe("environments on the surface", () => {
  it("shows the caller's own environments only", async () => {
    const view = await readProvidersView(await signIn(OWNER), {}, deps());
    expect(view.environments.map((option) => option.id)).toEqual([
      ownerEnvironmentId,
    ]);
    expect(view.selected?.id).toBe(ownerEnvironmentId);

    // A bookmarked id from another tenant falls back rather than leaking.
    const other = await readProvidersView(
      await signIn(OWNER),
      { environmentId: outsiderEnvironmentId },
      deps(),
    );
    expect(other.selected?.id).toBe(ownerEnvironmentId);
  });

  it("keeps a control-plane environment row per organization", async () => {
    const rows = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.organizationId, ownerOrgId));
    expect(rows.map((row) => row.id)).toEqual([ownerEnvironmentId]);
  });
});
