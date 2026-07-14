import type { AdminClient } from "./http.js";
import { isHttpError } from "./http.js";
import { isLoopbackUrl } from "./loopback-url.js";
import type { Output } from "./output.js";

/**
 * The testable orchestration behind `hogsend connect discord`. Every side
 * effect (HTTP, browser, prompt, clock, randomness) is injected via
 * {@link ConnectDiscordFlowDeps}; the command file stays a thin argv/usage
 * wrapper, mirroring {@link runConnectPosthog} / connect-flow.ts.
 *
 * Unlike PostHog (which is a real OAuth handshake on the laptop), the Discord
 * bot flow is a one-time portal paste: the operator creates a Discord
 * application, copies four values (app id, public key, bot token, client
 * secret) into the prompt, the CLI PUTs them onto the instance, the server
 * wires the interactions endpoint via PATCH /applications/@me, and the CLI
 * opens the one-click bot-install link. The guild id lands via the advanced
 * bot-auth callback (the server captures it in the derived credential).
 *
 * SECRET HYGIENE INVARIANT: no bot token, client secret, or public key is ever
 * passed to any `out.*` call or included in the returned
 * {@link ConnectDiscordResult}. The CLI also refuses to PUT secrets to a
 * plain-http non-loopback instance.
 */

/** Mirror of GET /v1/admin/connectors/discord/connect-info (engine route). */
export interface DiscordConnectInfoResponse {
  providerId: "discord";
  apiPublicUrl: string;
  /** ${API_PUBLIC_URL}/v1/connectors/discord/oauth/callback */
  redirectUri: string;
  /** ${API_PUBLIC_URL}/v1/connectors/discord/interactions */
  interactionsUrl: string;
  /** Whether the inline gateway runtime's lease-holder is live (Worker Online). */
  workerOnline: boolean;
  /** Whether a derived `discord` credential is already stored. */
  credentialStored: boolean;
  /** The captured guild id once the bot install completes (else null). */
  guildId: string | null;
  /** Whether the interactions endpoint has been wired (PATCH succeeded). */
  botInstalled: boolean;
  /**
   * The one-click bot-install URL, SERVER-MINTED with a signed CSRF `state`.
   * `null` until the Discord secrets are stored (the server has no app id to
   * build it from yet). This is the SINGLE canonical install URL — the CLI
   * opens this rather than building one client-side, so the unauthenticated
   * oauth callback always sees a valid state.
   */
  installUrl: string | null;
}

export type ConnectDiscordVerdict =
  | "connected" // secrets stored + interactions wired
  | "secrets_stored_not_wired"; // secrets stored; wiring deferred (loopback)

export type ConnectDiscordFailure =
  | "not_configured" // connect-info reports no usable public url (non-interactive)
  | "api_public_url_unreachable" // instance API_PUBLIC_URL is a loopback address
  | "wire_failed" // PATCH /applications/@me failed
  | "store_failed" // PUT secrets failed
  | "paste_aborted"; // a required value was left blank

export class ConnectDiscordError extends Error {
  readonly verdict: ConnectDiscordFailure;
  readonly hint?: string;

  constructor(verdict: ConnectDiscordFailure, message: string, hint?: string) {
    super(message);
    this.name = "ConnectDiscordError";
    this.verdict = verdict;
    this.hint = hint;
  }
}

export interface ConnectDiscordResult {
  verdict: ConnectDiscordVerdict;
  providerId: "discord";
  /** cfg.baseUrl — the Hogsend instance this run targeted. */
  instance: string;
  /** Whether the four secrets were stored on the instance this run. */
  secretsStored: boolean;
  /** Whether the interactions endpoint was wired (PATCH /applications/@me). */
  wired: boolean;
  /**
   * The SERVER-MINTED bot-install URL the operator opens to add the bot to a
   * guild (carries a signed CSRF `state` the oauth callback verifies). `null`
   * when the server has no install URL yet (secrets not stored / `--status`
   * before connect).
   */
  botInstallUrl: string | null;
  /** The guild id captured via the bot-auth callback, when the poll saw it. */
  guildId: string | null;
}

/** The four values pasted from the Discord developer portal. */
export interface DiscordSecrets {
  appId: string;
  publicKey: string;
  botToken: string;
  clientSecret: string;
}

export interface ConnectDiscordFlowDeps {
  http: AdminClient;
  out: Output;
  /** ctx.out.interactive — gates the secret-paste prompts. */
  interactive: boolean;
  /**
   * Collect the four pasted portal values. Injected (a bail-wrapped clack
   * text/password sequence in the command file) so tests never prompt. Only
   * called in interactive mode; non-interactive runs fail `not_configured`.
   */
  promptSecrets: () => Promise<DiscordSecrets>;
  /** bail-wrapped clack confirm; injected so tests never prompt. */
  confirm: (message: string) => Promise<boolean>;
  openBrowser: (url: string) => boolean;
  now: () => Date;
}

export interface ConnectDiscordFlowOptions {
  noBrowser: boolean;
  /** --status: read connect-info and report; never prompts or PUTs. */
  statusOnly: boolean;
}

// --- UX text — exact strings -----------------------------------------------

const HINT_NOT_CONFIGURED =
  "Run `hogsend connect discord` interactively (in a terminal) to paste the " +
  "four Discord portal values. To only read the current state, re-run with " +
  "--status (which never prompts).";

const HINT_LOOPBACK =
  "Discord validates the interactions endpoint by PINGing it synchronously, " +
  "so it must be publicly reachable. Run this against your DEPLOYED instance " +
  "(point --url at it); the secrets are stored either way.";

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Build the one-click bot-install authorize URL.
 *
 * NOTE: the live flow does NOT use this — the install URL is SERVER-MINTED
 * (`connect-info.installUrl`, carrying a signed CSRF `state` the unauthenticated
 * oauth callback verifies). The CLI cannot mint a state the server would accept
 * (no `BETTER_AUTH_SECRET`), so a client-built URL is unusable. Kept only as a
 * pure URL-shape helper for tests.
 */
export function buildBotInstallUrl(opts: {
  applicationId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", opts.applicationId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "bot applications.commands");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  // Advanced bot-auth: the callback receives `guild_id` so the server can
  // capture which guild the bot was installed into.
  url.searchParams.set("integration_type", "0");
  return url.toString();
}

function portalSteps(info: DiscordConnectInfoResponse): string {
  return [
    "One-time Discord developer portal setup:",
    "",
    "  1. https://discord.com/developers/applications -> New Application",
    "  2. Bot tab -> Reset Token -> copy the BOT TOKEN. Enable the privileged",
    "     gateway intents: SERVER MEMBERS, MESSAGE CONTENT, PRESENCE.",
    "  3. OAuth2 tab -> copy the CLIENT ID (= application id) and CLIENT",
    "     SECRET. Add this exact redirect URL:",
    `       ${info.redirectUri}`,
    "  4. General Information tab -> copy the PUBLIC KEY.",
    "",
    "The interactions endpoint is wired for you (you do NOT paste it):",
    `  ${info.interactionsUrl}`,
  ].join("\n");
}

/**
 * Run the full Discord connect flow (or the `--status` read-only shortcut).
 * Resolves with a {@link ConnectDiscordResult} whenever the secrets are stored
 * (even if wiring was deferred for a loopback instance); throws
 * {@link ConnectDiscordError} otherwise.
 */
export async function runConnectDiscord(
  deps: ConnectDiscordFlowDeps,
  opts: ConnectDiscordFlowOptions,
): Promise<ConnectDiscordResult> {
  const base = deps.http.cfg.baseUrl;

  // 1. Ask the server what it knows — the CLI needs no Discord env vars.
  const info = await deps.out.step(
    `GET ${base}/v1/admin/connectors/discord/connect-info`,
    () =>
      deps.http.get<DiscordConnectInfoResponse>(
        "/v1/admin/connectors/discord/connect-info",
      ),
  );

  // --status: report what's stored/wired and stop. Never prompts or PUTs.
  if (opts.statusOnly) {
    deps.out.note(
      [
        "Discord connection status",
        `  instance        ${base}`,
        `  secrets stored  ${info.credentialStored ? "yes" : "no"}`,
        `  interactions    ${info.botInstalled ? "wired" : "not wired"}`,
        `  guild id        ${info.guildId ?? "(not yet captured)"}`,
        `  worker online   ${info.workerOnline ? "yes" : "no"}`,
        `  install url     ${info.installUrl ?? "(stored secrets first)"}`,
      ].join("\n"),
    );
    // The most common "secrets set but nothing happens" cause is the worker not
    // holding the socket. Surface the actionable next step (the ingress secret
    // is no longer part of the default path).
    if (info.credentialStored && !info.workerOnline) {
      deps.out.log(
        "Worker offline: set DISCORD_BOT_TOKEN + the API's REDIS_URL on the " +
          "worker service and redeploy. If it stays offline with the token set, " +
          "enable the 3 privileged gateway intents in the Discord portal.",
      );
    }
    return {
      verdict: info.botInstalled ? "connected" : "secrets_stored_not_wired",
      providerId: "discord",
      instance: base,
      secretsStored: info.credentialStored,
      wired: info.botInstalled,
      // The SERVER-MINTED install URL (carries a valid signed state). Null until
      // the secrets are stored — there's nothing for the operator to open yet.
      botInstallUrl: info.installUrl,
      guildId: info.guildId,
    };
  }

  // 2. Print the exact portal steps + the redirect URI to register.
  deps.out.note(portalSteps(info), "Discord portal");

  // 3. Collect + store the four pasted values. Non-interactive runs can't
  //    safely prompt for secrets, so they fail not_configured.
  if (!deps.interactive) {
    throw new ConnectDiscordError(
      "not_configured",
      "Discord connect needs the four portal values pasted interactively",
      HINT_NOT_CONFIGURED,
    );
  }

  const secrets = await deps.promptSecrets();
  if (
    !secrets.appId.trim() ||
    !secrets.publicKey.trim() ||
    !secrets.botToken.trim() ||
    !secrets.clientSecret.trim()
  ) {
    throw new ConnectDiscordError(
      "paste_aborted",
      "all four values (application id, public key, bot token, client " +
        "secret) are required",
    );
  }

  try {
    await deps.out.step(`PUT ${base}/v1/admin/connectors/discord/secrets`, () =>
      deps.http.put("/v1/admin/connectors/discord/secrets", {
        appId: secrets.appId.trim(),
        publicKey: secrets.publicKey.trim(),
        botToken: secrets.botToken.trim(),
        clientSecret: secrets.clientSecret.trim(),
      }),
    );
  } catch (err) {
    if (isHttpError(err) && err.status === 404) {
      throw new ConnectDiscordError(
        "store_failed",
        "this instance has not mounted the Discord admin routes " +
          "(PUT /v1/admin/connectors/discord/secrets returned 404)",
        "Mount the consumer /secrets + /wire routes — see " +
          "docs/connect-discord-consumer-routes.md.",
      );
    }
    throw new ConnectDiscordError("store_failed", errMsg(err));
  }

  // Re-read connect-info: now that the app id is stored, the server mints the
  // canonical install URL (with a signed CSRF `state`). The CLI NEVER builds
  // this URL itself — a client-minted state would be rejected by the callback.
  const stored = await deps.out.step(
    "Reading the server-minted install URL",
    () =>
      deps.http.get<DiscordConnectInfoResponse>(
        "/v1/admin/connectors/discord/connect-info",
      ),
  );
  const botInstallUrl = stored.installUrl;

  // 4. Wire the interactions endpoint server-side (PATCH /applications/@me).
  //    Discord PINGs interactionsUrl synchronously to validate it, so a
  //    loopback API_PUBLIC_URL cannot be wired — defer and tell the operator.
  if (isLoopbackUrl(info.apiPublicUrl)) {
    deps.out.note(
      `Secrets stored, but this instance's API_PUBLIC_URL is ${info.apiPublicUrl} ` +
        "(a loopback address). Discord cannot reach the interactions endpoint, " +
        "so wiring was skipped.\n\nWire it against your deployed instance:\n\n" +
        "  hogsend connect discord --url https://your-instance",
      "Instance not publicly reachable",
    );
    return {
      verdict: "secrets_stored_not_wired",
      providerId: "discord",
      instance: base,
      secretsStored: true,
      wired: false,
      botInstallUrl,
      guildId: info.guildId,
    };
  }

  try {
    await deps.out.step(`POST ${base}/v1/admin/connectors/discord/wire`, () =>
      deps.http.post("/v1/admin/connectors/discord/wire", {}),
    );
  } catch (err) {
    // The wire route 409s when API_PUBLIC_URL is loopback (belt-and-suspenders
    // with the local check above) — surface it as the unreachable verdict.
    if (
      isHttpError(err) &&
      err.status === 409 &&
      httpErrorBody(err) === "api_public_url_unreachable"
    ) {
      throw new ConnectDiscordError(
        "api_public_url_unreachable",
        `API_PUBLIC_URL is ${info.apiPublicUrl} — Discord cannot PING the ` +
          "interactions endpoint",
        HINT_LOOPBACK,
      );
    }
    if (isHttpError(err) && err.status === 404) {
      throw new ConnectDiscordError(
        "wire_failed",
        "this instance has not mounted the Discord /wire route (404)",
        "Mount the consumer /secrets + /wire routes — see " +
          "docs/connect-discord-consumer-routes.md.",
      );
    }
    throw new ConnectDiscordError("wire_failed", errMsg(err));
  }

  // 5. Open the SERVER-MINTED one-click bot-install link and capture the guild
  //    id. `botInstallUrl` is null only if the server somehow has no app id
  //    despite the just-successful store — guard rather than open `null`.
  let opened = false;
  if (botInstallUrl) {
    deps.out.note(
      ["Add the bot to your server", `  ${botInstallUrl}`].join("\n"),
    );
    opened = opts.noBrowser ? false : deps.openBrowser(botInstallUrl);
    deps.out.log(
      opened
        ? "Opening your browser to install the bot. Approve the install in " +
            "your server, then this command finishes capturing the guild id."
        : "Open this URL in a browser to install the bot into your server:",
    );
    deps.out.log(`  ${botInstallUrl}`);
  } else {
    deps.out.log(
      "Secrets stored, but the server returned no install URL. Re-run " +
        "`hogsend connect discord --status` to read it.",
    );
  }

  // 6. Poll connect-info for the captured guild id (the server records it on
  //    the bot-auth callback). Best-effort: a still-null guild id is fine — the
  //    operator may complete the install later, then re-run with --status.
  //    Seed from the post-store read (freshest) so a guild already captured
  //    short-circuits the confirm prompt + the extra GET.
  let guildId = stored.guildId;
  if (!guildId && !opts.noBrowser) {
    const proceed = await deps.confirm(
      "Once you've approved the bot install in your browser, press Enter to " +
        "capture the guild id (or skip and re-run with --status later)",
    );
    if (proceed) {
      try {
        const refreshed = await deps.out.step(
          "Capturing the installed guild id",
          () =>
            deps.http.get<DiscordConnectInfoResponse>(
              "/v1/admin/connectors/discord/connect-info",
            ),
        );
        guildId = refreshed.guildId;
      } catch {
        // soft — the install is wired; the guild id can be read later.
      }
    }
  }

  if (!guildId) {
    deps.out.log(
      "Bot install not yet detected. Complete it in your browser, then run " +
        "`hogsend connect discord --status` to capture the guild id.",
    );
  }

  return {
    verdict: "connected",
    providerId: "discord",
    instance: base,
    secretsStored: true,
    wired: true,
    botInstallUrl,
    guildId,
  };
}

const httpErrorBody = (err: unknown): string | undefined => {
  if (!isHttpError(err)) return undefined;
  const body = err.body;
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return undefined;
};
