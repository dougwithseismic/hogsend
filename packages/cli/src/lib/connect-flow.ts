import type { AdminClient } from "./http.js";
import { isHttpError } from "./http.js";
import { LoopbackError, type LoopbackServer } from "./loopback.js";
import type { DiscoveryResult, TokenResponse } from "./oauth.js";
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
  LOOPBACK_PORTS,
  POSTHOG_CLIENT_ID,
  POSTHOG_SCOPES,
  REQUIRED_ACCESS_LEVEL,
} from "./oauth.js";
import type { Output } from "./output.js";

/**
 * The testable orchestration behind `hogsend connect posthog`. Every side
 * effect (HTTP, discovery, loopback server, code exchange, browser, prompt,
 * clock) is injected via {@link ConnectFlowDeps}; the command file stays a
 * thin argv/usage wrapper.
 *
 * TOKEN HYGIENE INVARIANT: no access token, refresh token, authorization
 * code, or code verifier is ever passed to any `out.*` call or included in
 * the returned {@link ConnectResult}.
 */

/** Mirror of GET /v1/admin/analytics/connect-info (engine analytics route). */
export interface ConnectInfoResponse {
  providerId: "posthog";
  analyticsConfigured: boolean;
  privateHost: string | null;
  hostExplicit: boolean;
  projectIdHint: string | null;
  personalKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  apiPublicUrl: string;
}

/** Loose mirror of POST /v1/admin/analytics/provision-loop's 200 (M10: any 2xx is success, no strict parse). */
interface ProvisionLoopResponse {
  provisioned?: boolean;
  created?: boolean;
  action?: string;
  hogFunctionId?: string;
  webhookUrl?: string;
  dashboardUrl?: string;
}

export type ConnectVerdict =
  | "connected" // credential stored + loop provisioned
  | "connected_no_provision"; // credential stored; provision skipped or failed

export type ConnectFailure =
  | "not_configured" // privateHost null (or US-cloud assumption declined)
  | "oauth_unsupported" // discovery 404
  | "discovery_failed"
  | "port_unavailable"
  | "consent_denied"
  | "state_mismatch"
  | "callback_timeout"
  | "exchange_failed"
  | "store_failed"
  | "no_credential" // --provision-only with nothing stored
  | "webhook_secret_missing" // --provision-only without POSTHOG_WEBHOOK_SECRET
  | "provision_failed"; // --provision-only and the POST itself failed

export class ConnectError extends Error {
  readonly verdict: ConnectFailure;
  readonly hint?: string;

  constructor(verdict: ConnectFailure, message: string, hint?: string) {
    super(message);
    this.name = "ConnectError";
    this.verdict = verdict;
    this.hint = hint;
  }
}

export interface ConnectResult {
  verdict: ConnectVerdict;
  providerId: "posthog";
  /** cfg.baseUrl — the Hogsend instance this run targeted. */
  instance: string;
  posthog: {
    privateHost: string;
    issuer?: string;
    scopes: string;
    scopedTeams: number[];
    scopedOrganizations: string[];
  } | null; // null for --provision-only
  credential: { stored: boolean; expiresAt?: string };
  provision:
    | {
        attempted: true;
        ok: true;
        created: boolean;
        hogFunctionId: string;
        webhookUrl: string;
      }
    | { attempted: true; ok: false; error: string }
    | {
        attempted: false;
        skipped: "webhook_secret_missing" | "no_provision_flag";
      };
}

export interface ConnectFlowDeps {
  http: AdminClient;
  out: Output;
  /** ctx.out.interactive — gates the US-cloud confirm prompt. */
  interactive: boolean;
  discover: (opts: { privateHost: string }) => Promise<DiscoveryResult>;
  startLoopback: (opts: {
    ports: readonly number[];
    state: string;
  }) => Promise<LoopbackServer>;
  exchangeCode: (opts: {
    tokenEndpoint: string;
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<TokenResponse>;
  openBrowser: (url: string) => boolean;
  /** bail-wrapped clack confirm; injected so tests never prompt. */
  confirm: (message: string) => Promise<boolean>;
  now: () => Date;
}

export interface ConnectFlowOptions {
  provisionOnly: boolean;
  noProvision: boolean;
  noBrowser: boolean;
  timeoutMs?: number;
}

// --- §7 UX text — exact strings for failure modes / notes ------------------

const HINT_NOT_CONFIGURED =
  "Set POSTHOG_API_KEY (and POSTHOG_HOST for EU/self-hosted) on the " +
  "instance, redeploy, then re-run. The server's PostHog config tells the " +
  "CLI which region to authorize against.";

const hintOauthUnsupported = (privateHost: string): string =>
  `${privateHost} doesn't advertise an OAuth server (discovery returned 404).
Self-hosted PostHog builds may not ship OAuth. Use a personal API key instead:

  1. In PostHog: Settings -> User -> Personal API keys -> create a key scoped
     person:read, person:write, project:read, hog_function:write
  2. Set POSTHOG_PERSONAL_API_KEY=<key> on your Hogsend instance (api + worker)
  3. Redeploy — person reads and loop provisioning use the key automatically.`;

const HINT_PORTS =
  "Ports 8423-8425 on 127.0.0.1 are all in use — free one and re-run. The " +
  "OAuth callback must land on one of these fixed ports; they are " +
  "registered in Hogsend's OAuth client document.";

const SSH_NOTE = `The consent page must open in a browser on THIS machine — the OAuth callback
returns to 127.0.0.1 here. On a remote/SSH session this cannot complete: run
the command from your laptop instead and point --url at the instance (the CLI
never needs to run on the server).`;

const WEBHOOK_SECRET_NOTE = `Credential stored — but the PostHog -> Hogsend event loop needs a shared
webhook secret, and this instance doesn't have one yet. Finish the loop:

  1. Generate a secret:        openssl rand -hex 32
  2. Set it on the instance:   POSTHOG_WEBHOOK_SECRET=<secret>  (api AND worker)
  3. Redeploy, then run:       hogsend connect posthog --provision-only`;

// ---------------------------------------------------------------------------

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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

/** Map a LoopbackError reason onto the ConnectError vocabulary (§5.5 d). */
function fromLoopbackError(err: LoopbackError): ConnectError {
  switch (err.reason) {
    case "consent_denied":
      return new ConnectError(
        "consent_denied",
        "authorization was denied in PostHog — re-run the command if that " +
          "was a mistake",
      );
    case "state_mismatch":
      return new ConnectError(
        "state_mismatch",
        "state mismatch on the OAuth callback — possible CSRF; retry the " +
          "command",
      );
    case "timeout":
      return new ConnectError(
        "callback_timeout",
        "timed out waiting for the OAuth callback (5 minutes) — re-run " +
          "when you're ready to approve in the browser",
      );
    case "ports_busy":
      return new ConnectError("port_unavailable", err.message, HINT_PORTS);
    case "oauth_error":
      return new ConnectError("exchange_failed", err.message);
  }
}

/** Mandatory provisioning for `--provision-only` (a failure fails the run). */
async function runProvisionOnly(
  deps: ConnectFlowDeps,
  info: ConnectInfoResponse,
  base: string,
): Promise<ConnectResult> {
  if (info.webhookSecretConfigured === false) {
    deps.out.note(WEBHOOK_SECRET_NOTE, "Webhook secret missing");
    throw new ConnectError(
      "webhook_secret_missing",
      "POSTHOG_WEBHOOK_SECRET is not set on the instance — nothing to " +
        "provision against",
    );
  }

  let result: ProvisionLoopResponse;
  try {
    result = await deps.out.step(
      `POST ${base}/v1/admin/analytics/provision-loop`,
      () =>
        deps.http.post<ProvisionLoopResponse>(
          "/v1/admin/analytics/provision-loop",
          {},
        ),
    );
  } catch (err) {
    if (
      isHttpError(err) &&
      err.status === 409 &&
      httpErrorBody(err) === "no_posthog_credential"
    ) {
      throw new ConnectError(
        "no_credential",
        "no PostHog credential is stored on this instance",
        "run `hogsend connect posthog` first",
      );
    }
    throw new ConnectError("provision_failed", errMsg(err));
  }

  printProvisioned(deps.out, result);

  return {
    verdict: "connected",
    providerId: "posthog",
    instance: base,
    posthog: null,
    credential: { stored: false },
    provision: {
      attempted: true,
      ok: true,
      created: result.created === true,
      hogFunctionId: result.hogFunctionId ?? "",
      webhookUrl: result.webhookUrl ?? "",
    },
  };
}

function printProvisioned(out: Output, result: ProvisionLoopResponse): void {
  out.note(
    [
      "PostHog -> Hogsend loop provisioned",
      `  webhookUrl     ${result.webhookUrl ?? "(unknown)"}`,
      `  hogFunctionId  ${result.hogFunctionId ?? "(unknown)"}`,
      `  created        ${result.created === true ? "yes" : "no (existing function adopted)"}`,
    ].join("\n"),
  );
}

/**
 * Run the full connect flow (or the `--provision-only` shortcut). Resolves
 * with a {@link ConnectResult} whenever a credential is stored (even if
 * provisioning was skipped or failed); throws {@link ConnectError} otherwise.
 */
export async function runConnectPosthog(
  deps: ConnectFlowDeps,
  opts: ConnectFlowOptions,
): Promise<ConnectResult> {
  const base = deps.http.cfg.baseUrl;

  // a/b. Ask the server what it knows — the CLI needs no PostHog env vars.
  const info = await deps.out.step(
    `GET ${base}/v1/admin/analytics/connect-info`,
    () =>
      deps.http.get<ConnectInfoResponse>("/v1/admin/analytics/connect-info"),
  );

  const privateHost = info.privateHost;
  if (privateHost === null) {
    throw new ConnectError(
      "not_configured",
      "this instance has no PostHog configuration",
      HINT_NOT_CONFIGURED,
    );
  }

  if (opts.provisionOnly) {
    return runProvisionOnly(deps, info, base);
  }

  if (info.hostExplicit === false) {
    if (deps.interactive) {
      const proceed = await deps.confirm(
        "No POSTHOG_HOST set on the instance — assume PostHog US Cloud " +
          `(${privateHost})?`,
      );
      if (!proceed) {
        throw new ConnectError(
          "not_configured",
          "set POSTHOG_HOST on the instance to pick the right region",
        );
      }
    } else {
      deps.out.log(
        "warning: no POSTHOG_HOST set on the instance — assuming PostHog " +
          `US Cloud (${privateHost}).`,
      );
    }
  }

  if (info.personalKeyConfigured === true) {
    deps.out.log(
      "note: POSTHOG_PERSONAL_API_KEY is set on the instance; the OAuth " +
        "credential will take precedence once stored.",
    );
  }

  // c. Discover the region's OAuth server from the instance's private host.
  const metadata = await deps.out.step(
    `OAuth discovery at ${privateHost}`,
    async () => {
      const result = await deps.discover({ privateHost });
      if (result.status === "unsupported") {
        throw new ConnectError(
          "oauth_unsupported",
          `${privateHost} doesn't advertise an OAuth server (discovery ` +
            "returned 404)",
          hintOauthUnsupported(privateHost),
        );
      }
      if (result.status === "error") {
        throw new ConnectError("discovery_failed", result.message);
      }
      return result.metadata;
    },
  );

  try {
    if (new URL(metadata.issuer).origin !== new URL(privateHost).origin) {
      deps.out.log(
        `warning: discovery issuer ${metadata.issuer} differs from ` +
          `${privateHost} — continuing.`,
      );
    }
  } catch {
    // unparseable issuer — cosmetic check only
  }

  // d. PKCE + state + loopback receiver + browser consent.
  const pkce = generatePkce();
  const state = generateState();

  let server: LoopbackServer;
  try {
    server = await deps.startLoopback({ ports: LOOPBACK_PORTS, state });
  } catch (err) {
    if (err instanceof LoopbackError) throw fromLoopbackError(err);
    throw err;
  }

  let code: string;
  try {
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: POSTHOG_CLIENT_ID,
      redirectUri: server.redirectUri,
      scope: POSTHOG_SCOPES,
      state,
      pkce,
      requiredAccessLevel: REQUIRED_ACCESS_LEVEL,
    });

    deps.out.note(
      [
        "About to authorize Hogsend against PostHog",
        `  instance   ${base}`,
        `  posthog    ${privateHost}`,
        `  scopes     ${POSTHOG_SCOPES}`,
        `  callback   ${server.redirectUri}`,
      ].join("\n"),
    );

    const opened = opts.noBrowser ? false : deps.openBrowser(authorizeUrl);
    deps.out.log(
      opened
        ? "Opening your browser. If nothing happens, open this URL yourself:"
        : "Open this URL in a browser on THIS machine:",
    );
    deps.out.log(`  ${authorizeUrl}`);
    if (!opened) {
      deps.out.note(SSH_NOTE);
    }

    const callback = await deps.out.step(
      "Waiting for PostHog authorization (Ctrl-C aborts)",
      () => server.waitForCallback({ timeoutMs: opts.timeoutMs }),
    );
    code = callback.code;
  } catch (err) {
    if (err instanceof LoopbackError) throw fromLoopbackError(err);
    throw err;
  } finally {
    await server.close();
  }

  // e. Exchange the code (public client, PKCE) for tokens.
  const tokenEndpoint = metadata.token_endpoint;
  let tokens: TokenResponse;
  try {
    tokens = await deps.out.step(`Exchanging code at ${tokenEndpoint}`, () =>
      deps.exchangeCode({
        tokenEndpoint,
        clientId: POSTHOG_CLIENT_ID,
        code,
        codeVerifier: pkce.verifier,
        redirectUri: server.redirectUri,
      }),
    );
  } catch (err) {
    throw new ConnectError("exchange_failed", errMsg(err));
  }

  // f. Store the credential on the instance (canonical payload, SYNTHESIS §0).
  const expiresAt = new Date(
    deps.now().getTime() + tokens.expires_in * 1000,
  ).toISOString();
  const scopes = (tokens.scope ?? POSTHOG_SCOPES).split(" ");
  const scopedTeams = tokens.scoped_teams ?? [];
  const scopedOrganizations = tokens.scoped_organizations ?? [];

  try {
    await deps.out.step(
      `PUT ${base}/v1/admin/provider-credentials/posthog`,
      () =>
        deps.http.put("/v1/admin/provider-credentials/posthog", {
          kind: "oauth",
          payload: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt,
            tokenEndpoint,
            clientId: POSTHOG_CLIENT_ID,
            scopes,
            scopedTeams,
            scopedOrganizations,
          },
        }),
    );
  } catch (err) {
    throw new ConnectError("store_failed", errMsg(err));
  }

  const stored: Pick<ConnectResult, "providerId" | "instance" | "posthog"> & {
    credential: ConnectResult["credential"];
  } = {
    providerId: "posthog",
    instance: base,
    posthog: {
      privateHost,
      issuer: metadata.issuer,
      scopes: scopes.join(" "),
      scopedTeams,
      scopedOrganizations,
    },
    credential: { stored: true, expiresAt },
  };

  // g. Provision the PostHog → Hogsend loop (soft: the credential is stored,
  //    so a provisioning failure never fails the command).
  if (opts.noProvision) {
    return {
      verdict: "connected_no_provision",
      ...stored,
      provision: { attempted: false, skipped: "no_provision_flag" },
    };
  }

  if (info.webhookSecretConfigured === false) {
    deps.out.note(WEBHOOK_SECRET_NOTE, "Webhook secret missing");
    return {
      verdict: "connected_no_provision",
      ...stored,
      provision: { attempted: false, skipped: "webhook_secret_missing" },
    };
  }

  try {
    const result = await deps.out.step(
      `POST ${base}/v1/admin/analytics/provision-loop`,
      () =>
        deps.http.post<ProvisionLoopResponse>(
          "/v1/admin/analytics/provision-loop",
          {},
        ),
    );
    printProvisioned(deps.out, result);
    return {
      verdict: "connected",
      ...stored,
      provision: {
        attempted: true,
        ok: true,
        created: result.created === true,
        hogFunctionId: result.hogFunctionId ?? "",
        webhookUrl: result.webhookUrl ?? "",
      },
    };
  } catch (err) {
    const message = errMsg(err);
    deps.out.log(
      "The credential is stored, but provisioning the event loop failed: " +
        `${message}. Re-run with: hogsend connect posthog --provision-only`,
    );
    return {
      verdict: "connected_no_provision",
      ...stored,
      provision: { attempted: true, ok: false, error: message },
    };
  }
}
