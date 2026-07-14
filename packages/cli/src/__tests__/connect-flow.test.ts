import { describe, expect, it } from "vitest";
import {
  ConnectError,
  type ConnectFlowDeps,
  type ConnectFlowOptions,
  type ConnectInfoResponse,
  runConnectPosthog,
} from "../lib/connect-flow.js";
import type { AdminClient, HttpError } from "../lib/http.js";
import { LoopbackError, type LoopbackServer } from "../lib/loopback.js";
import type { DiscoveryResult, TokenResponse } from "../lib/oauth.js";
import { POSTHOG_CLIENT_ID, POSTHOG_SCOPES } from "../lib/oauth.js";
import type { Output } from "../lib/output.js";

// Everything is dependency-injected — no vi.mock needed (mirrors the
// lib-heavy test style of hatchet-token / dns-apply / admin-recovery).

const BASE_URL = "https://api.example.com";
const NOW = new Date("2026-06-12T18:00:00Z");

const DISCOVERY_OK: DiscoveryResult = {
  status: "ok",
  metadata: {
    issuer: "https://eu.posthog.com",
    authorization_endpoint: "https://eu.posthog.com/oauth/authorize/",
    token_endpoint: "https://eu.posthog.com/oauth/token/",
  },
};

const TOKENS: TokenResponse = {
  access_token: "pha_fixture_access_secret",
  refresh_token: "phr_fixture_refresh_secret",
  token_type: "Bearer",
  expires_in: 36_000,
  scope: POSTHOG_SCOPES,
  scoped_teams: [123],
  scoped_organizations: [],
};

const PROVISION_OK = {
  provisioned: true,
  created: true,
  action: "created",
  hogFunctionId: "hf-123",
  webhookUrl: `${BASE_URL}/v1/webhooks/posthog`,
  dashboardUrl:
    "https://eu.posthog.com/project/1/pipeline/destinations/hog-hf-123/configuration",
};

function connectInfo(
  over: Partial<ConnectInfoResponse> = {},
): ConnectInfoResponse {
  return {
    providerId: "posthog",
    analyticsConfigured: true,
    privateHost: "https://eu.posthog.com",
    hostExplicit: true,
    projectIdHint: null,
    personalKeyConfigured: false,
    webhookSecretConfigured: true,
    apiPublicUrl: BASE_URL,
    ...over,
  };
}

function makeHttpError(status: number, body: unknown): HttpError {
  const err = new Error(`request failed with status ${status}`) as HttpError;
  err.name = "HttpError";
  err.status = status;
  err.body = body;
  return err;
}

interface Harness {
  deps: ConnectFlowDeps;
  /** Every string handed to ANY out.* sink (labels, logs, notes, kv, ...). */
  sink: string[];
  calls: {
    get: string[];
    put: Array<{ path: string; body: unknown }>;
    post: Array<{ path: string; body: unknown }>;
    discover: string[];
    exchange: Array<{
      tokenEndpoint: string;
      clientId: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }>;
    browserUrls: string[];
    loopbackStates: string[];
  };
  server: { closed: boolean };
}

function makeHarness(opts: {
  info?: ConnectInfoResponse;
  discovery?: DiscoveryResult;
  tokens?: TokenResponse | Error;
  waitResult?: { code: string } | LoopbackError;
  startLoopbackError?: LoopbackError;
  putError?: Error;
  postResult?: unknown | Error;
  interactive?: boolean;
  confirmAnswer?: boolean;
  /** Injected region resolver for the keyless (privateHost null) path. */
  selectRegion?: () => Promise<string>;
}): Harness {
  const sink: string[] = [];
  const calls: Harness["calls"] = {
    get: [],
    put: [],
    post: [],
    discover: [],
    exchange: [],
    browserUrls: [],
    loopbackStates: [],
  };
  const server = { closed: false };

  const out: Output = {
    interactive: opts.interactive ?? false,
    isJson: false,
    intro: (title) => {
      sink.push(title);
    },
    step: async (label, fn) => {
      sink.push(label);
      return fn();
    },
    note: (body, title) => {
      sink.push(title ? `${title}\n${body}` : body);
    },
    table: () => {},
    kv: (obj, title) => {
      sink.push(`${title ?? ""}${JSON.stringify(obj)}`);
    },
    log: (msg) => {
      sink.push(msg);
    },
    json: (payload) => {
      sink.push(JSON.stringify(payload));
    },
    outro: (msg) => {
      sink.push(msg);
    },
    fail: (message): never => {
      throw new Error(`fail: ${message}`);
    },
  };

  const http = {
    cfg: { baseUrl: BASE_URL } as AdminClient["cfg"],
    get: async (path: string) => {
      calls.get.push(path);
      return (opts.info ?? connectInfo()) as never;
    },
    put: async (path: string, body: unknown) => {
      calls.put.push({ path, body });
      if (opts.putError) throw opts.putError;
      return {} as never;
    },
    post: async (path: string, body: unknown) => {
      calls.post.push({ path, body });
      const result = opts.postResult ?? PROVISION_OK;
      if (result instanceof Error) throw result;
      return result as never;
    },
    patch: async () => {
      throw new Error("unexpected PATCH");
    },
    del: async () => {
      throw new Error("unexpected DELETE");
    },
  } as AdminClient;

  const loopbackServer: LoopbackServer = {
    port: 8423,
    redirectUri: "http://127.0.0.1:8423/callback",
    waitForCallback: async () => {
      const result = opts.waitResult ?? { code: "abc" };
      if (result instanceof LoopbackError) throw result;
      return result;
    },
    close: async () => {
      server.closed = true;
    },
  };

  const deps: ConnectFlowDeps = {
    http,
    out,
    interactive: opts.interactive ?? false,
    discover: async ({ privateHost }) => {
      calls.discover.push(privateHost);
      return opts.discovery ?? DISCOVERY_OK;
    },
    startLoopback: async ({ state }) => {
      calls.loopbackStates.push(state);
      if (opts.startLoopbackError) throw opts.startLoopbackError;
      return loopbackServer;
    },
    exchangeCode: async (exchangeOpts) => {
      calls.exchange.push(exchangeOpts);
      const tokens = opts.tokens ?? TOKENS;
      if (tokens instanceof Error) throw tokens;
      return tokens;
    },
    openBrowser: (url) => {
      calls.browserUrls.push(url);
      return true;
    },
    confirm: async () => opts.confirmAnswer ?? true,
    ...(opts.selectRegion ? { selectRegion: opts.selectRegion } : {}),
    now: () => NOW,
  };

  return { deps, sink, calls, server };
}

const FLOW_DEFAULTS: ConnectFlowOptions = {
  provisionOnly: false,
  noProvision: false,
  noBrowser: false,
};

const expectConnectError = async (
  promise: Promise<unknown>,
  verdict: string,
) => {
  await expect(promise).rejects.toSatisfy((err: unknown) => {
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).verdict).toBe(verdict);
    return true;
  });
};

describe("runConnectPosthog — happy path", () => {
  it("stores the canonical credential, provisions, and reports connected", async () => {
    const h = makeHarness({});
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected");
    expect(result.instance).toBe(BASE_URL);
    expect(result.posthog?.scopedTeams).toEqual([123]);

    // PUT: path + the §3.2 body, exactly.
    expect(h.calls.put).toHaveLength(1);
    expect(h.calls.put[0]?.path).toBe("/v1/admin/provider-credentials/posthog");
    expect(h.calls.put[0]?.body).toEqual({
      kind: "oauth",
      payload: {
        accessToken: "pha_fixture_access_secret",
        refreshToken: "phr_fixture_refresh_secret",
        // now (18:00Z) + 36000 s = 04:00Z next day.
        expiresAt: "2026-06-13T04:00:00.000Z",
        tokenEndpoint: "https://eu.posthog.com/oauth/token/",
        clientId: POSTHOG_CLIENT_ID,
        // The granted scopes are the front-loaded set the token response
        // carries (TOKENS.scope === POSTHOG_SCOPES), split on whitespace.
        scopes: POSTHOG_SCOPES.split(" "),
        scopedTeams: [123],
        scopedOrganizations: [],
      },
    });

    // Provision POST called with {}.
    expect(h.calls.post).toEqual([
      { path: "/v1/admin/analytics/provision-loop", body: {} },
    ]);

    // The browser URL carries the generated state + PKCE + identity params.
    expect(h.calls.browserUrls).toHaveLength(1);
    const url = new URL(h.calls.browserUrls[0] ?? "");
    expect(url.searchParams.get("state")).toBe(h.calls.loopbackStates[0]);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(POSTHOG_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(POSTHOG_SCOPES);

    expect(result.provision).toMatchObject({
      attempted: true,
      ok: true,
      created: true,
      hogFunctionId: "hf-123",
      webhookUrl: `${BASE_URL}/v1/webhooks/posthog`,
    });
    expect(h.server.closed).toBe(true);
  });

  it("never leaks tokens, the code, or the verifier to the output sink", async () => {
    const h = makeHarness({});
    await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    const verifier = h.calls.exchange[0]?.codeVerifier ?? "";
    expect(verifier.length).toBeGreaterThan(0);

    const all = h.sink.join("\n");
    expect(all).not.toContain("pha_fixture_access_secret");
    expect(all).not.toContain("phr_fixture_refresh_secret");
    expect(all).not.toContain(verifier);
  });
});

describe("runConnectPosthog — failure verdicts", () => {
  it("not_configured when privateHost is null", async () => {
    const h = makeHarness({ info: connectInfo({ privateHost: null }) });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "not_configured",
    );
  });

  it("oauth_unsupported on discovery 404 — no loopback, no exchange", async () => {
    const h = makeHarness({ discovery: { status: "unsupported" } });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "oauth_unsupported",
    );
    expect(h.calls.loopbackStates).toHaveLength(0);
    expect(h.calls.exchange).toHaveLength(0);
  });

  it("state_mismatch closes the server and never exchanges/stores", async () => {
    const h = makeHarness({
      waitResult: new LoopbackError("state_mismatch", "state mismatch"),
    });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "state_mismatch",
    );
    expect(h.calls.exchange).toHaveLength(0);
    expect(h.calls.put).toHaveLength(0);
    expect(h.server.closed).toBe(true);
  });

  it("port_unavailable when all loopback ports are busy", async () => {
    const h = makeHarness({
      startLoopbackError: new LoopbackError("ports_busy", "ports busy"),
    });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "port_unavailable",
    );
  });

  it("exchange_failed (missing refresh token) — PUT never called", async () => {
    const h = makeHarness({
      tokens: new Error(
        "token response missing refresh_token — cannot store a long-lived credential",
      ),
    });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "exchange_failed",
    );
    expect(h.calls.put).toHaveLength(0);
  });
});

describe("runConnectPosthog — provisioning outcomes", () => {
  it("proceeds to provision even when the webhook secret is unconfigured (server mints it)", async () => {
    // webhookSecretConfigured:false no longer short-circuits — the server mints
    // + persists the secret during provisioning, so the flow stores the
    // credential AND POSTs provision-loop, landing on `connected`.
    const h = makeHarness({
      info: connectInfo({ webhookSecretConfigured: false }),
    });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected");
    expect(h.calls.put).toHaveLength(1);
    expect(h.calls.post).toEqual([
      { path: "/v1/admin/analytics/provision-loop", body: {} },
    ]);
    expect(result.provision).toMatchObject({ attempted: true, ok: true });
  });

  it("provisions a DISABLED placeholder when API_PUBLIC_URL is loopback", async () => {
    const h = makeHarness({
      info: connectInfo({ apiPublicUrl: "http://localhost:3002" }),
      postResult: {
        provisioned: true,
        created: true,
        action: "created",
        hogFunctionId: "hf-ph",
        webhookUrl: "https://CHANGEME.yourdomain.com/v1/webhooks/posthog",
        dashboardUrl: "https://eu.posthog.com/project/1/pipeline/x",
        enabled: false,
      },
    });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected_no_provision");
    expect(h.calls.put).toHaveLength(1);
    expect(h.calls.post).toEqual([
      {
        path: "/v1/admin/analytics/provision-loop?placeholder=true",
        body: {},
      },
    ]);
    expect(result.provision).toMatchObject({
      attempted: true,
      ok: true,
      enabled: false,
      hogFunctionId: "hf-ph",
    });
    // The "what was created" note names the object + the go-live command.
    const note = h.sink.find((s) => s.includes("DISABLED until you go live"));
    expect(note).toBeDefined();
    expect(note).toContain("CHANGEME.yourdomain.com");
    expect(note).toContain("--provision-only --url");
  });

  it("falls back to the skip note when the placeholder POST fails (older engine)", async () => {
    const h = makeHarness({
      info: connectInfo({ apiPublicUrl: "http://localhost:3002" }),
      postResult: new Error("409 api_public_url_unreachable"),
    });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected_no_provision");
    expect(h.calls.put).toHaveLength(1);
    expect(result.provision).toEqual({
      attempted: false,
      skipped: "api_public_url_unreachable",
    });
    const note = h.sink.find((s) => s.includes("loopback"));
    expect(note).toBeDefined();
    expect(note).toContain("--provision-only");
  });

  it("a failed provision POST resolves connected_no_provision (exit stays 0)", async () => {
    const h = makeHarness({
      postResult: makeHttpError(500, { error: "boom" }),
    });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected_no_provision");
    expect(result.provision).toMatchObject({ attempted: true, ok: false });
    expect(result.credential.stored).toBe(true);
  });

  it("--no-provision stops after storing the credential", async () => {
    const h = makeHarness({});
    const result = await runConnectPosthog(h.deps, {
      ...FLOW_DEFAULTS,
      noProvision: true,
    });
    expect(result.verdict).toBe("connected_no_provision");
    expect(result.provision).toEqual({
      attempted: false,
      skipped: "no_provision_flag",
    });
    expect(h.calls.post).toHaveLength(0);
  });
});

describe("runConnectPosthog — --provision-only", () => {
  const PROVISION_ONLY: ConnectFlowOptions = {
    ...FLOW_DEFAULTS,
    provisionOnly: true,
  };

  it("skips OAuth entirely and POSTs once", async () => {
    const h = makeHarness({});
    const result = await runConnectPosthog(h.deps, PROVISION_ONLY);

    expect(result.verdict).toBe("connected");
    expect(result.posthog).toBeNull();
    expect(h.calls.discover).toHaveLength(0);
    expect(h.calls.loopbackStates).toHaveLength(0);
    expect(h.calls.exchange).toHaveLength(0);
    expect(h.calls.put).toHaveLength(0);
    expect(h.calls.post).toHaveLength(1);
  });

  it("maps a 409 no_posthog_credential to no_credential with a hint", async () => {
    const h = makeHarness({
      postResult: makeHttpError(409, { error: "no_posthog_credential" }),
    });
    await expect(runConnectPosthog(h.deps, PROVISION_ONLY)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(ConnectError);
        expect((err as ConnectError).verdict).toBe("no_credential");
        expect((err as ConnectError).hint).toContain("hogsend connect posthog");
        return true;
      },
    );
  });

  it("hard-fails api_public_url_unreachable under --provision-only", async () => {
    const h = makeHarness({
      info: connectInfo({ apiPublicUrl: "http://127.0.0.1:3002" }),
    });
    await expectConnectError(
      runConnectPosthog(h.deps, PROVISION_ONLY),
      "api_public_url_unreachable",
    );
    expect(h.calls.post).toHaveLength(0);
  });

  it("provisions even when the webhook secret is unconfigured (server mints it)", async () => {
    // --provision-only no longer gates on webhookSecretConfigured — the server
    // mints + persists the secret during provisioning, so the POST proceeds.
    const h = makeHarness({
      info: connectInfo({ webhookSecretConfigured: false }),
    });
    const result = await runConnectPosthog(h.deps, PROVISION_ONLY);
    expect(result.verdict).toBe("connected");
    expect(h.calls.post).toHaveLength(1);
  });

  it("any other non-2xx is provision_failed", async () => {
    const h = makeHarness({
      postResult: makeHttpError(502, {
        error: "missing-scope",
        detail: "denied",
      }),
    });
    await expectConnectError(
      runConnectPosthog(h.deps, PROVISION_ONLY),
      "provision_failed",
    );
  });
});

describe("runConnectPosthog — keyless / region resolution", () => {
  it("resolves the region from --posthog-host on a keyless instance and proceeds", async () => {
    // Server reports no PostHog config (privateHost null) — the CLI no longer
    // hard-fails not_configured; it derives the region from the flag and runs
    // the full OAuth handshake against it.
    const h = makeHarness({ info: connectInfo({ privateHost: null }) });
    const result = await runConnectPosthog(h.deps, {
      ...FLOW_DEFAULTS,
      posthogHost: "https://eu.posthog.com/",
    });

    expect(result.verdict).toBe("connected");
    // Trailing slash stripped; discovery + the OAuth flow ran against it.
    expect(h.calls.discover).toEqual(["https://eu.posthog.com"]);
    expect(result.posthog?.privateHost).toBe("https://eu.posthog.com");
    expect(h.calls.put).toHaveLength(1);
  });

  it("non-interactive keyless without a flag still fails not_configured", async () => {
    const h = makeHarness({
      info: connectInfo({ privateHost: null }),
      interactive: false,
    });
    await expectConnectError(
      runConnectPosthog(h.deps, FLOW_DEFAULTS),
      "not_configured",
    );
    expect(h.calls.discover).toHaveLength(0);
  });

  it("interactive keyless uses the injected selectRegion prompt", async () => {
    const selectRegion = async () => "https://us.posthog.com";
    const h = makeHarness({
      info: connectInfo({ privateHost: null }),
      interactive: true,
      selectRegion,
    });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected");
    expect(h.calls.discover).toEqual(["https://us.posthog.com"]);
    expect(result.posthog?.privateHost).toBe("https://us.posthog.com");
  });
});

describe("runConnectPosthog — scope downscope advisory", () => {
  it("prints a note when PostHog grants fewer scopes than requested", async () => {
    // A REAL downscope: query:read has no :write sibling in the grant, so
    // dropping it is a genuine gap the note must report.
    const granted = POSTHOG_SCOPES.split(" ")
      .filter((s) => s !== "query:read")
      .join(" ");
    const h = makeHarness({ tokens: { ...TOKENS, scope: granted } });
    const result = await runConnectPosthog(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected");
    const note = h.sink.find((s) => s.includes("PostHog granted"));
    expect(note).toBeDefined();
    expect(note).toContain("query:read");
  });

  it("does NOT report a :read scope satisfied by its granted :write half", async () => {
    // PostHog's scope model is hierarchical (write implies read) and the
    // grant normalizes a both-halves request down to write-only. Dropping
    // cohort:read while cohort:write is granted is NOT a downscope — a full
    // consent looks exactly like this, so no note may print.
    const granted = POSTHOG_SCOPES.split(" ")
      .filter((s) => s !== "cohort:read")
      .join(" ");
    const h = makeHarness({ tokens: { ...TOKENS, scope: granted } });
    await runConnectPosthog(h.deps, FLOW_DEFAULTS);
    expect(h.sink.find((s) => s.includes("PostHog granted"))).toBeUndefined();
  });

  it("prints no note when PostHog grants the full requested set", async () => {
    // Default TOKENS.scope === POSTHOG_SCOPES — a full grant.
    const h = makeHarness({});
    await runConnectPosthog(h.deps, FLOW_DEFAULTS);
    expect(h.sink.find((s) => s.includes("PostHog granted"))).toBeUndefined();
  });
});
