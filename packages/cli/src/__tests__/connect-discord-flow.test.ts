import { describe, expect, it } from "vitest";
import {
  buildBotInstallUrl,
  ConnectDiscordError,
  type ConnectDiscordFlowDeps,
  type ConnectDiscordFlowOptions,
  type DiscordConnectInfoResponse,
  type DiscordSecrets,
  runConnectDiscord,
} from "../lib/connect-discord-flow.js";
import type { AdminClient, HttpError } from "../lib/http.js";
import type { Output } from "../lib/output.js";

// Everything is dependency-injected — no vi.mock needed (mirrors
// connect-flow.test.ts's harness style).

const BASE_URL = "https://api.example.com";
const NOW = new Date("2026-06-13T18:00:00Z");

const SECRETS: DiscordSecrets = {
  appId: "1234567890",
  publicKey: "pubkey_fixture_hex",
  botToken: "bot_token_fixture_secret",
  clientSecret: "client_fixture_secret",
};

// The server-minted install URL the connect-info read returns once the secrets
// are stored — carries a signed CSRF `state` the CLI never builds itself.
const SERVER_INSTALL_URL =
  "https://discord.com/oauth2/authorize?client_id=1234567890&response_type=" +
  "code&scope=bot+applications.commands&redirect_uri=" +
  encodeURIComponent(`${BASE_URL}/v1/connectors/discord/oauth/callback`) +
  "&state=server-signed-state";

function connectInfo(
  over: Partial<DiscordConnectInfoResponse> = {},
): DiscordConnectInfoResponse {
  return {
    providerId: "discord",
    apiPublicUrl: BASE_URL,
    redirectUri: `${BASE_URL}/v1/connectors/discord/oauth/callback`,
    interactionsUrl: `${BASE_URL}/v1/connectors/discord/interactions`,
    ingressSecretConfigured: true,
    credentialStored: false,
    guildId: null,
    botInstalled: false,
    installUrl: null,
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
  deps: ConnectDiscordFlowDeps;
  /** Every string handed to ANY out.* sink. */
  sink: string[];
  calls: {
    get: string[];
    put: Array<{ path: string; body: unknown }>;
    post: Array<{ path: string; body: unknown }>;
    browserUrls: string[];
    promptCount: number;
  };
}

function makeHarness(opts: {
  info?: DiscordConnectInfoResponse;
  /** Second GET (poll) override — falls back to the first `info`. */
  pollInfo?: DiscordConnectInfoResponse;
  secrets?: DiscordSecrets;
  putError?: Error;
  postResult?: unknown | Error;
  interactive?: boolean;
  confirmAnswer?: boolean;
}): Harness {
  const sink: string[] = [];
  const calls: Harness["calls"] = {
    get: [],
    put: [],
    post: [],
    browserUrls: [],
    promptCount: 0,
  };

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

  let getCount = 0;
  const http = {
    cfg: { baseUrl: BASE_URL } as AdminClient["cfg"],
    get: async (path: string) => {
      calls.get.push(path);
      getCount += 1;
      const first = opts.info ?? connectInfo();
      const result = getCount === 1 ? first : (opts.pollInfo ?? first);
      return result as never;
    },
    put: async (path: string, body: unknown) => {
      calls.put.push({ path, body });
      if (opts.putError) throw opts.putError;
      return {} as never;
    },
    post: async (path: string, body: unknown) => {
      calls.post.push({ path, body });
      const result = opts.postResult ?? {};
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

  const deps: ConnectDiscordFlowDeps = {
    http,
    out,
    interactive: opts.interactive ?? false,
    confirm: async () => opts.confirmAnswer ?? true,
    openBrowser: (url) => {
      calls.browserUrls.push(url);
      return true;
    },
    promptSecrets: async () => {
      calls.promptCount += 1;
      return opts.secrets ?? SECRETS;
    },
    now: () => NOW,
  };

  return { deps, sink, calls };
}

const FLOW_DEFAULTS: ConnectDiscordFlowOptions = {
  noBrowser: false,
  statusOnly: false,
};

const expectError = async (promise: Promise<unknown>, verdict: string) => {
  await expect(promise).rejects.toSatisfy((err: unknown) => {
    expect(err).toBeInstanceOf(ConnectDiscordError);
    expect((err as ConnectDiscordError).verdict).toBe(verdict);
    return true;
  });
};

describe("buildBotInstallUrl", () => {
  it("carries the app id, scopes, redirect, and CSRF state", () => {
    const url = new URL(
      buildBotInstallUrl({
        applicationId: "9999",
        redirectUri: "https://x.example/cb",
        state: "st4te",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("9999");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x.example/cb");
    expect(url.searchParams.get("state")).toBe("st4te");
  });
});

describe("runConnectDiscord — happy path", () => {
  it("stores the four secrets, wires, opens the SERVER install link, reports connected", async () => {
    const h = makeHarness({
      interactive: true,
      // The post-store connect-info read returns the server-minted install URL
      // AND (in this fixture) the captured guild id.
      pollInfo: connectInfo({
        guildId: "guild-42",
        botInstalled: true,
        installUrl: SERVER_INSTALL_URL,
      }),
    });
    const result = await runConnectDiscord(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("connected");
    expect(result.instance).toBe(BASE_URL);
    expect(result.secretsStored).toBe(true);
    expect(result.wired).toBe(true);
    expect(result.guildId).toBe("guild-42");
    // The result carries the SERVER-MINTED install URL, not a client-built one.
    expect(result.botInstallUrl).toBe(SERVER_INSTALL_URL);

    // The four pasted values PUT exactly, trimmed.
    expect(h.calls.put).toEqual([
      {
        path: "/v1/admin/connectors/discord/secrets",
        body: {
          appId: "1234567890",
          publicKey: "pubkey_fixture_hex",
          botToken: "bot_token_fixture_secret",
          clientSecret: "client_fixture_secret",
        },
      },
    ]);

    // Wire POSTed once with {}.
    expect(h.calls.post).toEqual([
      { path: "/v1/admin/connectors/discord/wire", body: {} },
    ]);

    // The CLI re-reads connect-info after storing to pick up the server URL.
    expect(h.calls.get).toEqual([
      "/v1/admin/connectors/discord/connect-info",
      "/v1/admin/connectors/discord/connect-info",
    ]);

    // The SERVER-MINTED install URL is opened verbatim — the CLI never builds
    // its own state (the server-signed state is the only one the callback
    // accepts).
    expect(h.calls.browserUrls).toEqual([SERVER_INSTALL_URL]);
    const url = new URL(h.calls.browserUrls[0] ?? "");
    expect(url.searchParams.get("state")).toBe("server-signed-state");
  });

  it("never leaks the bot token / client secret to the output sink", async () => {
    const h = makeHarness({
      interactive: true,
      pollInfo: connectInfo({
        botInstalled: true,
        guildId: "g",
        installUrl: SERVER_INSTALL_URL,
      }),
    });
    await runConnectDiscord(h.deps, FLOW_DEFAULTS);

    const all = h.sink.join("\n");
    expect(all).not.toContain("bot_token_fixture_secret");
    expect(all).not.toContain("client_fixture_secret");
  });
});

describe("runConnectDiscord — failure verdicts", () => {
  it("not_configured when non-interactive (can't safely prompt for secrets)", async () => {
    const h = makeHarness({ interactive: false });
    await expectError(
      runConnectDiscord(h.deps, FLOW_DEFAULTS),
      "not_configured",
    );
    // Never prompted, never PUT.
    expect(h.calls.promptCount).toBe(0);
    expect(h.calls.put).toHaveLength(0);
  });

  it("paste_aborted when a required value is blank", async () => {
    const h = makeHarness({
      interactive: true,
      secrets: { ...SECRETS, botToken: "  " },
    });
    await expectError(
      runConnectDiscord(h.deps, FLOW_DEFAULTS),
      "paste_aborted",
    );
    expect(h.calls.put).toHaveLength(0);
  });

  it("store_failed when the secrets PUT fails — no wire", async () => {
    const h = makeHarness({
      interactive: true,
      putError: makeHttpError(500, { error: "boom" }),
    });
    await expectError(runConnectDiscord(h.deps, FLOW_DEFAULTS), "store_failed");
    expect(h.calls.post).toHaveLength(0);
  });

  it("wire_failed when the wire POST fails", async () => {
    const h = makeHarness({
      interactive: true,
      postResult: makeHttpError(500, { error: "patch failed" }),
    });
    await expectError(runConnectDiscord(h.deps, FLOW_DEFAULTS), "wire_failed");
    // Secrets were stored before the wire attempt.
    expect(h.calls.put).toHaveLength(1);
  });

  it("maps a 409 api_public_url_unreachable from the wire POST", async () => {
    const h = makeHarness({
      interactive: true,
      postResult: makeHttpError(409, { error: "api_public_url_unreachable" }),
    });
    await expectError(
      runConnectDiscord(h.deps, FLOW_DEFAULTS),
      "api_public_url_unreachable",
    );
  });
});

describe("runConnectDiscord — loopback defer", () => {
  it("stores secrets but skips wiring when API_PUBLIC_URL is loopback", async () => {
    const h = makeHarness({
      interactive: true,
      info: connectInfo({ apiPublicUrl: "http://localhost:3002" }),
    });
    const result = await runConnectDiscord(h.deps, FLOW_DEFAULTS);

    expect(result.verdict).toBe("secrets_stored_not_wired");
    expect(result.secretsStored).toBe(true);
    expect(result.wired).toBe(false);
    expect(h.calls.put).toHaveLength(1);
    expect(h.calls.post).toHaveLength(0);

    const note = h.sink.find((s) => s.includes("loopback"));
    expect(note).toBeDefined();
    expect(note).toContain("--url");
  });
});

describe("runConnectDiscord — --status", () => {
  const STATUS: ConnectDiscordFlowOptions = {
    ...FLOW_DEFAULTS,
    statusOnly: true,
  };

  it("reads connect-info and reports without prompting or PUTting", async () => {
    const h = makeHarness({
      info: connectInfo({
        credentialStored: true,
        botInstalled: true,
        guildId: "guild-7",
      }),
    });
    const result = await runConnectDiscord(h.deps, STATUS);

    expect(result.verdict).toBe("connected");
    expect(result.wired).toBe(true);
    expect(result.guildId).toBe("guild-7");
    expect(h.calls.get).toEqual(["/v1/admin/connectors/discord/connect-info"]);
    expect(h.calls.promptCount).toBe(0);
    expect(h.calls.put).toHaveLength(0);
    expect(h.calls.post).toHaveLength(0);
    expect(h.calls.browserUrls).toHaveLength(0);
  });

  it("reports secrets_stored_not_wired when not yet wired", async () => {
    const h = makeHarness({
      info: connectInfo({ credentialStored: true, botInstalled: false }),
    });
    const result = await runConnectDiscord(h.deps, STATUS);
    expect(result.verdict).toBe("secrets_stored_not_wired");
    expect(result.wired).toBe(false);
  });
});

describe("runConnectDiscord — --no-browser", () => {
  it("does not open a browser and prints the SERVER install URL", async () => {
    const h = makeHarness({
      interactive: true,
      pollInfo: connectInfo({
        botInstalled: true,
        guildId: "g",
        installUrl: SERVER_INSTALL_URL,
      }),
    });
    const result = await runConnectDiscord(h.deps, {
      ...FLOW_DEFAULTS,
      noBrowser: true,
    });

    expect(result.verdict).toBe("connected");
    expect(result.botInstallUrl).toBe(SERVER_INSTALL_URL);
    expect(h.calls.browserUrls).toHaveLength(0);
    const printed = h.sink.find((s) => s.includes("discord.com/oauth2"));
    expect(printed).toBeDefined();
  });
});
