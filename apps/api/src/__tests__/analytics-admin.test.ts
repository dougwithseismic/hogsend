import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DB-touching test: point at the real docker TimescaleDB, overriding the
// vitest.config placeholder DATABASE_URL (mirrors the other admin-route tests).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// ONE env permutation per file — the engine env is import-time-frozen. The
// per-test permutations live in (a) the pure resolveConnectInfo matrix and
// (b) a container-level env proxy override (below) for the success path.
process.env.POSTHOG_API_KEY = "phc_analytics_admin_test";
process.env.POSTHOG_HOST = "https://eu.i.posthog.com";
process.env.POSTHOG_PROJECT_ID = "4242";
process.env.API_PUBLIC_URL = "https://t.example.com";
delete process.env.POSTHOG_WEBHOOK_SECRET;
delete process.env.POSTHOG_PERSONAL_API_KEY;
delete process.env.POSTHOG_PRIVATE_HOST;

// Hatchet seam: these routes never enqueue tasks, but createHogsendClient
// constructs the hatchet client — mock the API re-export so no gRPC dial can
// ever happen (same shape as admin-provider-credentials.test.ts).
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { providerCredentials } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  getDerivedCredential,
  saveDerivedCredential,
  saveProviderCredential,
} = await import("@hogsend/engine");

// `resolveConnectInfo` lives on the engine's analytics admin router and is
// not part of the engine's public index. A literal static import of another
// package's src would trip rootDir (TS6059) under `tsc --noEmit`; the
// variable specifier keeps tsc out of it (same trick as
// provision-posthog-loop.test.ts). Shapes mirror the route's exports.
interface ConnectInfoShape {
  providerId: "posthog";
  analyticsConfigured: boolean;
  privateHost: string | null;
  hostExplicit: boolean;
  projectIdHint: string | null;
  personalKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  apiPublicUrl: string;
}
interface ConnectInfoEnv {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PRIVATE_HOST?: string;
  POSTHOG_PROJECT_ID?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_WEBHOOK_SECRET?: string;
  API_PUBLIC_URL: string;
}
const analyticsModulePath = new URL(
  "../../../../packages/engine/src/routes/admin/analytics.ts",
  import.meta.url,
).pathname;
const { resolveConnectInfo } = (await import(
  /* @vite-ignore */ analyticsModulePath
)) as { resolveConnectInfo: (env: ConnectInfoEnv) => ConnectInfoShape };

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

// Per-test env overrides without rebooting the engine: the routes read
// `c.get("container").env` per request, so wrapping the container's env in a
// proxy lets a single file cover both "secret unset" (the process default
// above) and "secret set" (the provision success path).
const envOverrides = new Map<string, unknown>();
const realEnv = container.env;
(container as { env: typeof realEnv }).env = new Proxy(realEnv, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && envOverrides.has(prop)) {
      return envOverrides.get(prop);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as typeof realEnv;

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// The route hard-codes providerId "posthog", so this file must use the real
// id: back up any pre-existing row (shared dev DB) and restore it after.
let backedUpRow: typeof providerCredentials.$inferSelect | undefined;

beforeAll(async () => {
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.providerId, "posthog"));
  backedUpRow = rows[0];
  await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.providerId, "posthog"));
});

afterAll(async () => {
  await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.providerId, "posthog"));
  if (backedUpRow) {
    await db.insert(providerCredentials).values(backedUpRow);
  }
});

afterEach(() => {
  envOverrides.clear();
  vi.restoreAllMocks();
});

const APP_ENV: ConnectInfoEnv = { API_PUBLIC_URL: "https://t.example.com" };

// --- resolveConnectInfo (pure — no app boot) --------------------------------

describe("resolveConnectInfo", () => {
  it("returns privateHost null and all-false flags with no PostHog signal", () => {
    expect(resolveConnectInfo(APP_ENV)).toEqual({
      providerId: "posthog",
      analyticsConfigured: false,
      privateHost: null,
      hostExplicit: false,
      projectIdHint: null,
      personalKeyConfigured: false,
      webhookSecretConfigured: false,
      apiPublicUrl: "https://t.example.com",
    });
  });

  it("assumes US Cloud when only POSTHOG_API_KEY is set", () => {
    const info = resolveConnectInfo({ ...APP_ENV, POSTHOG_API_KEY: "phc_x" });
    expect(info.privateHost).toBe("https://us.posthog.com");
    expect(info.hostExplicit).toBe(false);
    expect(info.analyticsConfigured).toBe(true);
  });

  it("derives the private host from POSTHOG_HOST (strips the .i. label)", () => {
    const info = resolveConnectInfo({
      ...APP_ENV,
      POSTHOG_HOST: "https://eu.i.posthog.com",
    });
    expect(info.privateHost).toBe("https://eu.posthog.com");
    expect(info.hostExplicit).toBe(true);
  });

  it("POSTHOG_PRIVATE_HOST wins over POSTHOG_HOST; trailing slash stripped", () => {
    const info = resolveConnectInfo({
      ...APP_ENV,
      POSTHOG_HOST: "https://eu.i.posthog.com",
      POSTHOG_PRIVATE_HOST: "https://ph.internal.example/",
    });
    expect(info.privateHost).toBe("https://ph.internal.example");
    expect(info.hostExplicit).toBe(true);
  });

  it("flows secret/personal-key/project-id through; echoes API_PUBLIC_URL", () => {
    const info = resolveConnectInfo({
      ...APP_ENV,
      POSTHOG_API_KEY: "phc_x",
      POSTHOG_WEBHOOK_SECRET: "whsec",
      POSTHOG_PERSONAL_API_KEY: "phx_y",
      POSTHOG_PROJECT_ID: "199032",
    });
    expect(info.webhookSecretConfigured).toBe(true);
    expect(info.personalKeyConfigured).toBe(true);
    expect(info.projectIdHint).toBe("199032");
    expect(info.apiPublicUrl).toBe("https://t.example.com");
  });
});

// --- GET /v1/admin/analytics/connect-info ------------------------------------

describe("GET /v1/admin/analytics/connect-info", () => {
  it("returns 401 without admin credentials", async () => {
    const res = await app.request("/v1/admin/analytics/connect-info");
    expect(res.status).toBe(401);
  });

  it("returns the env projection (secrets only as configured-ness)", async () => {
    const res = await app.request("/v1/admin/analytics/connect-info", {
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(200);
    // The handler augments the pure env projection with `scopeGap` (empty when
    // no oauth credential is stored) and OR-s `webhookSecretConfigured` against
    // the kind="derived" store (none here, so still env-only = false).
    expect(await res.json()).toEqual({
      providerId: "posthog",
      analyticsConfigured: true,
      privateHost: "https://eu.posthog.com",
      hostExplicit: true,
      projectIdHint: "4242",
      personalKeyConfigured: false,
      webhookSecretConfigured: false,
      apiPublicUrl: "https://t.example.com",
      scopeGap: [],
    });
  });

  it("reports scopeGap = the EXPECTED scopes the stored grant is missing", async () => {
    // Store an oauth credential on the legacy 4-scope set; the front-loaded
    // EXPECTED set is wider, so the gap is the difference.
    await saveProviderCredential(db, {
      providerId: "posthog",
      payload: STORED_PAYLOAD,
    });
    try {
      const res = await app.request("/v1/admin/analytics/connect-info", {
        headers: ADMIN_HEADER,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { scopeGap: string[] };
      // The stored grant covers person:read/write, project:read,
      // hog_function:write — everything else in the EXPECTED set is missing.
      expect(json.scopeGap).toContain("organization:read");
      expect(json.scopeGap).toContain("cohort:read");
      expect(json.scopeGap).not.toContain("person:read");
      expect(json.scopeGap).not.toContain("hog_function:write");
    } finally {
      await db
        .delete(providerCredentials)
        .where(eq(providerCredentials.providerId, "posthog"));
    }
  });

  it("reports webhookSecretConfigured=true from a stored derived secret (env unset)", async () => {
    await saveDerivedCredential(db, "posthog", { webhookSecret: "minted-abc" });
    try {
      const res = await app.request("/v1/admin/analytics/connect-info", {
        headers: ADMIN_HEADER,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { webhookSecretConfigured: boolean };
      // env.POSTHOG_WEBHOOK_SECRET is unset in this file, yet the stored
      // derived secret flips the configured-ness flag to true (env OR store).
      expect(json.webhookSecretConfigured).toBe(true);
    } finally {
      await db
        .delete(providerCredentials)
        .where(eq(providerCredentials.providerId, "posthog"));
    }
  });
});

// --- POST /v1/admin/analytics/provision-loop ---------------------------------

const provision = async () => {
  const res = await app.request("/v1/admin/analytics/provision-loop", {
    method: "POST",
    headers: ADMIN_HEADER,
    body: JSON.stringify({}),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
};

const STORED_PAYLOAD = {
  accessToken: "pha_route_test_access",
  refreshToken: "phr_route_test_refresh",
  // Far-future so the token manager never refreshes (no fetch on read).
  expiresAt: new Date(Date.now() + 36_000_000).toISOString(),
  tokenEndpoint: "https://eu.posthog.com/oauth/token/",
  clientId: "https://hogsend.com/.well-known/hogsend-posthog-client.json",
  scopes: ["person:read", "person:write", "project:read", "hog_function:write"],
  scopedTeams: [],
  scopedOrganizations: [],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("POST /v1/admin/analytics/provision-loop", () => {
  it("returns 401 without admin credentials", async () => {
    const res = await app.request("/v1/admin/analytics/provision-loop", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("409 no_posthog_credential when nothing is stored and no personal key", async () => {
    const { res, json } = await provision();
    expect(res.status).toBe(409);
    expect(json).toEqual({ error: "no_posthog_credential" });
  });

  it("mints + persists a webhook secret when env has none (no more 409)", async () => {
    await saveProviderCredential(db, {
      providerId: "posthog",
      payload: STORED_PAYLOAD,
    });
    try {
      // env.POSTHOG_WEBHOOK_SECRET is unset in this file. Instead of refusing,
      // the handler mints a secret, persists it to the kind="derived" store
      // (so the inbound posthog source can resolve it), and provisions.
      const recordedSecrets: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((async (
        input: unknown,
        init?: RequestInit,
      ) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (init?.body) {
          const body = String(init.body);
          const match = body.match(/x-posthog-webhook-secret"\s*:\s*"([^"]+)"/);
          if (match?.[1]) recordedSecrets.push(match[1]);
        }
        if (method === "GET" && url.includes("/api/projects/")) {
          return jsonResponse({ id: 4242, api_token: "phc_grabbed_key" });
        }
        if (method === "GET" && url.includes("/hog_functions/")) {
          return jsonResponse({ results: [], next: null });
        }
        if (method === "POST" && url.endsWith("/hog_functions/")) {
          return jsonResponse({ id: "hf-minted-1" });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }) as typeof fetch);

      const { res, json } = await provision();
      expect(res.status).toBe(200);
      expect(json).toMatchObject({
        provisioned: true,
        action: "created",
        hogFunctionId: "hf-minted-1",
      });

      // The minted secret was passed to PostHog AND persisted to the store.
      expect(recordedSecrets.length).toBeGreaterThan(0);
      const stored = await getDerivedCredential(db, "posthog");
      expect(stored?.webhookSecret).toBe(recordedSecrets[0]);
      expect(stored?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      // The phc_ (api_token) was grabbed opportunistically and persisted.
      expect(stored?.projectApiKey).toBe("phc_grabbed_key");
      expect(stored?.projectId).toBe("4242");
    } finally {
      await db
        .delete(providerCredentials)
        .where(eq(providerCredentials.providerId, "posthog"));
    }
  });

  it("200 translates the provisioner result per M4 (and passes the env project id)", async () => {
    envOverrides.set("POSTHOG_WEBHOOK_SECRET", "whsec_route_test");
    await saveProviderCredential(db, {
      providerId: "posthog",
      payload: STORED_PAYLOAD,
    });

    const recorded: Array<{ url: string; method: string; auth: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      recorded.push({
        url,
        method,
        auth: (init?.headers as Record<string, string> | undefined)
          ?.Authorization,
      });
      // The provisioner now ALWAYS fetches the project (even with an env
      // project id) to read its `api_token` (the phc_). With POSTHOG_PROJECT_ID
      // set it GETs /api/projects/4242/ directly (never @current).
      if (method === "GET" && url.includes("/api/projects/")) {
        return jsonResponse({ id: 4242, api_token: "phc_grabbed_key" });
      }
      if (method === "GET" && url.includes("/hog_functions/")) {
        return jsonResponse({ results: [], next: null });
      }
      if (method === "POST" && url.endsWith("/hog_functions/")) {
        return jsonResponse({ id: "hf-test-1" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch);

    const { res, json } = await provision();
    expect(res.status).toBe(200);
    expect(json).toEqual({
      provisioned: true,
      created: true,
      action: "created",
      hogFunctionId: "hf-test-1",
      webhookUrl: "https://t.example.com/v1/webhooks/posthog",
      dashboardUrl:
        "https://eu.posthog.com/project/4242/pipeline/destinations/" +
        "hog-hf-test-1/configuration",
    });

    // M8: env.POSTHOG_PROJECT_ID was passed — the project GET hits
    // /api/projects/4242/ directly (NOT @current) and the hog-function calls
    // hit the environment-scoped path, all with the stored token.
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.some((c) => c.url.includes("/api/projects/4242/"))).toBe(
      true,
    );
    for (const call of recorded) {
      expect(call.url).not.toContain("@current");
      expect(call.auth).toBe("Bearer pha_route_test_access");
    }

    // Token material never leaks into the response.
    expect(JSON.stringify(json)).not.toContain("pha_route_test_access");
  });

  it("502 maps other provisioner errors to { error: code, detail, remediation }", async () => {
    envOverrides.set("POSTHOG_WEBHOOK_SECRET", "whsec_route_test");
    await saveProviderCredential(db, {
      providerId: "posthog",
      payload: STORED_PAYLOAD,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
      jsonResponse({ detail: "denied" }, 403)) as unknown as typeof fetch);

    const { res, json } = await provision();
    expect(res.status).toBe(502);
    expect(json.error).toBe("missing-scope");
    expect(json.detail).toContain("403");
    expect(typeof json.remediation).toBe("string");
    expect(String(json.remediation)).toContain("hog_function:write");
  });
});

describe("isLoopbackPublicUrl", () => {
  it("classifies loopback and public hosts correctly", async () => {
    const { isLoopbackPublicUrl } = (await import(
      /* @vite-ignore */ analyticsModulePath
    )) as { isLoopbackPublicUrl: (url: string) => boolean };
    for (const url of [
      "http://localhost:3002",
      "http://127.0.0.1:3002",
      "http://0.0.0.0:8080",
      "http://[::1]:3002",
      "https://api.myapp.localhost",
    ]) {
      expect(isLoopbackPublicUrl(url), url).toBe(true);
    }
    for (const url of [
      "https://t.hogsend.com",
      "https://api.example.com:8443",
      "not a url",
    ]) {
      expect(isLoopbackPublicUrl(url), url).toBe(false);
    }
  });
});
