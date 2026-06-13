import { randomBytes } from "node:crypto";
import { DEFAULT_HOST, derivePrivateHost } from "@hogsend/plugin-posthog";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { createTokenManager } from "../../lib/oauth-token-manager.js";
import { EXPECTED_POSTHOG_SCOPES } from "../../lib/posthog-scopes.js";
import {
  getDerivedCredential,
  getProviderCredential,
  saveDerivedCredential,
} from "../../lib/provider-credentials.js";
import {
  ProvisionPostHogLoopError,
  provisionPostHogLoop,
} from "../../lib/provision-posthog-loop.js";
import { errorSchema } from "../../lib/schemas.js";

/**
 * Admin analytics-connection routes — the server half of
 * `hogsend connect posthog`. Mounted at `/v1/admin/analytics`, inheriting
 * `requireAdmin` + `rateLimit` + `auditMiddleware` from the admin router root.
 *
 * - `GET /connect-info` surfaces the instance's PostHog env signal so the CLI
 *   needs NO PostHog env vars locally (it learns the region + readiness from
 *   the server). Pure env projection — it never discovers anything.
 * - `POST /provision-loop` runs the idempotent PostHog → Hogsend hog-function
 *   provisioner server-side with the server's own credential (OAuth credential
 *   via a route-local token manager, falling back to the personal API key).
 */

export const connectInfoSchema = z.object({
  providerId: z.literal("posthog"),
  analyticsConfigured: z.boolean(),
  privateHost: z.string().nullable(),
  hostExplicit: z.boolean(),
  projectIdHint: z.string().nullable(),
  personalKeyConfigured: z.boolean(),
  webhookSecretConfigured: z.boolean(),
  apiPublicUrl: z.string(),
  /**
   * Expected PostHog OAuth scopes the stored credential is MISSING (the
   * CLI surfaces these so the user can reconnect for the broader grant).
   * `[]` when nothing is stored or the stored grant already covers them.
   * Computed in the handler — NOT part of the pure `resolveConnectInfo`
   * env projection (which `ConnectInfo` mirrors), so it omits this key.
   */
  scopeGap: z.array(z.string()),
});
export type ConnectInfo = Omit<z.infer<typeof connectInfoSchema>, "scopeGap">;

/**
 * True when a public URL points at a loopback/unspecified address — PostHog
 * Cloud can never deliver to it, so provisioning must refuse rather than
 * create (or repoint!) a destination nobody can reach.
 */
export function isLoopbackPublicUrl(publicUrl: string): boolean {
  try {
    const host = new URL(publicUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Pure env projection, exported for unit tests — no app boot needed.
 *
 * `privateHost: null` only when the server has NO PostHog signal at all (no
 * API key, no host overrides). When `POSTHOG_API_KEY` is set without a host,
 * the provider defaults to US Cloud, so the derived `https://us.posthog.com`
 * is returned with `hostExplicit: false` — the CLI warns and confirms.
 *
 * Surfaces env ONLY — project-id discovery belongs to the provisioner (M8),
 * and the webhook secret VALUE never leaves the server (only its
 * configured-ness does).
 */
export function resolveConnectInfo(env: {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PRIVATE_HOST?: string;
  POSTHOG_PROJECT_ID?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_WEBHOOK_SECRET?: string;
  API_PUBLIC_URL: string;
}): ConnectInfo {
  const hostExplicit = Boolean(env.POSTHOG_PRIVATE_HOST ?? env.POSTHOG_HOST);
  const configuredAtAll = Boolean(env.POSTHOG_API_KEY) || hostExplicit;
  const privateHost = !configuredAtAll
    ? null
    : (
        env.POSTHOG_PRIVATE_HOST ??
        derivePrivateHost(env.POSTHOG_HOST ?? DEFAULT_HOST)
      ).replace(/\/+$/, "");

  return {
    providerId: "posthog",
    analyticsConfigured: Boolean(env.POSTHOG_API_KEY),
    privateHost,
    hostExplicit,
    projectIdHint: env.POSTHOG_PROJECT_ID ?? null,
    personalKeyConfigured: Boolean(env.POSTHOG_PERSONAL_API_KEY),
    webhookSecretConfigured: Boolean(env.POSTHOG_WEBHOOK_SECRET),
    apiPublicUrl: env.API_PUBLIC_URL,
  };
}

const provisionLoopResponseSchema = z.object({
  provisioned: z.literal(true),
  /** `action === "created"` — false covers both "updated" and "unchanged". */
  created: z.boolean(),
  action: z.enum(["created", "updated", "unchanged"]),
  hogFunctionId: z.string(),
  webhookUrl: z.string(),
  dashboardUrl: z.string(),
});

const provisionFailureSchema = z.object({
  error: z.string(),
  detail: z.string(),
  remediation: z.string(),
});

const connectInfoRoute = createRoute({
  method: "get",
  path: "/connect-info",
  tags: ["Admin — Analytics"],
  summary: "PostHog connection info for `hogsend connect posthog`",
  responses: {
    200: {
      content: {
        "application/json": { schema: connectInfoSchema },
      },
      description:
        "The instance's PostHog env signal (region, readiness flags) — " +
        "secrets never appear, only their configured-ness",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing or invalid admin credentials",
    },
  },
});

const provisionLoopRoute = createRoute({
  method: "post",
  path: "/provision-loop",
  tags: ["Admin — Analytics"],
  summary: "Provision the PostHog → Hogsend event loop (webhook destination)",
  responses: {
    200: {
      content: {
        "application/json": { schema: provisionLoopResponseSchema },
      },
      description:
        "Loop provisioned (idempotent: created, updated, or unchanged)",
    },
    401: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing or invalid admin credentials",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Refused: `no_posthog_credential` (no OAuth credential and no " +
        "personal API key), `posthog_not_configured` (no PostHog env signal " +
        "at all), `webhook_secret_missing` (POSTHOG_WEBHOOK_SECRET unset), " +
        "or `api_public_url_unreachable` (API_PUBLIC_URL is loopback — " +
        "PostHog cannot deliver to it)",
    },
    502: {
      content: { "application/json": { schema: provisionFailureSchema } },
      description:
        "PostHog rejected the provisioning call — error is the provisioner " +
        "error code, remediation is operator-facing and printed verbatim",
    },
  },
});

export const analyticsAdminRouter = new OpenAPIHono<AppEnv>()
  .openapi(connectInfoRoute, async (c) => {
    const { db, env } = c.get("container");

    // The env projection is the pure base. The store can ALSO hold a minted
    // webhook secret (provision-loop mints + persists one when env lacks it),
    // so the configured-ness flag OR-s the two sources of truth.
    const storedDerived = await getDerivedCredential(db, "posthog");
    const webhookSecretConfigured =
      Boolean(env.POSTHOG_WEBHOOK_SECRET) ||
      Boolean(storedDerived?.webhookSecret);

    // scopeGap = expected scopes the STORED oauth credential is missing. No
    // credential ⇒ no gap to report (the connect flow will request the full
    // set). A decrypt failure is non-fatal here — fall back to no gap.
    let scopeGap: string[] = [];
    try {
      const oauth = await getProviderCredential(db, "posthog");
      if (oauth) {
        const granted = oauth.payload.scopes;
        scopeGap = EXPECTED_POSTHOG_SCOPES.filter((s) => !granted.includes(s));
      }
    } catch {
      scopeGap = [];
    }

    return c.json(
      { ...resolveConnectInfo(env), webhookSecretConfigured, scopeGap },
      200,
    );
  })
  .openapi(provisionLoopRoute, async (c) => {
    const { db, env, logger } = c.get("container");
    const info = resolveConnectInfo(env);

    // Credential check FIRST (M3), secret refusal second (enforced by the
    // provisioner itself). The container does NOT expose the token manager
    // (it is closed over inside the provider's accessor), so a route-local
    // instance is correct — the DB row is the shared truth and provisioning
    // is a one-shot admin action.
    const tokenManager = createTokenManager({
      db,
      providerId: "posthog",
      logger,
    });
    const accessToken =
      (await tokenManager.getAccessToken()) ??
      env.POSTHOG_PERSONAL_API_KEY ??
      null;
    if (!accessToken) {
      return c.json({ error: "no_posthog_credential" }, 409);
    }

    if (info.privateHost === null) {
      // A credential exists but the server has no PostHog env signal to tell
      // us which region to provision against.
      return c.json({ error: "posthog_not_configured" }, 409);
    }

    // PostHog Cloud cannot deliver webhooks to a loopback address — and a
    // local instance with a misconfigured API_PUBLIC_URL must never repoint
    // a production destination at localhost. Refuse BEFORE any PostHog call.
    if (isLoopbackPublicUrl(info.apiPublicUrl)) {
      return c.json(
        {
          error: "api_public_url_unreachable",
          detail: `API_PUBLIC_URL is ${info.apiPublicUrl} — PostHog cannot reach a loopback address.`,
          remediation:
            "Run this against your DEPLOYED instance (the credential is already stored there if you connected it): hogsend connect posthog --provision-only --url https://your-instance",
        },
        409,
      );
    }

    // Resolve the webhook secret instead of requiring it: env wins, else a
    // previously-minted stored secret, else mint a fresh one. When env has no
    // secret, persist the resolved value so it survives AND the inbound
    // posthog webhook source can resolve it from the store at request time
    // (the source falls OPEN otherwise). The stored payload is merged so an
    // existing phc_/projectId is preserved.
    const storedDerived = await getDerivedCredential(db, "posthog");
    const webhookSecret =
      env.POSTHOG_WEBHOOK_SECRET ??
      storedDerived?.webhookSecret ??
      randomBytes(32).toString("hex");
    if (env.POSTHOG_WEBHOOK_SECRET === undefined) {
      await saveDerivedCredential(db, "posthog", {
        ...(storedDerived ?? {}),
        webhookSecret,
      });
    }

    try {
      const result = await provisionPostHogLoop({
        privateHost: info.privateHost,
        accessToken,
        // M8: pass the env project id when set; else the provisioner runs its
        // own one-shot `@current` discovery.
        ...(env.POSTHOG_PROJECT_ID !== undefined
          ? { projectId: env.POSTHOG_PROJECT_ID }
          : {}),
        apiPublicUrl: info.apiPublicUrl,
        webhookSecret,
        logger,
      });

      // Opportunistically persist the phc_ (project api_token) the provisioner
      // read on its way through — it powers the OPTIONAL outbound capture path
      // and activates on the next deploy (no lazy boot-time seam). Re-read the
      // stored payload to merge over the just-persisted webhook secret.
      if (result.projectApiKey) {
        const cur = (await getDerivedCredential(db, "posthog")) ?? {};
        await saveDerivedCredential(db, "posthog", {
          ...cur,
          projectApiKey: result.projectApiKey,
          projectId: result.projectId,
          privateHost: info.privateHost,
        });
      }

      // M4 translation: the CLI's documented shape, with `action` riding
      // along for --json consumers.
      return c.json(
        {
          provisioned: true as const,
          created: result.action === "created",
          action: result.action,
          hogFunctionId: result.functionId,
          webhookUrl: result.webhookUrl,
          dashboardUrl: result.dashboardUrl,
        },
        200,
      );
    } catch (error) {
      if (error instanceof ProvisionPostHogLoopError) {
        if (error.code === "missing-webhook-secret") {
          return c.json({ error: "webhook_secret_missing" }, 409);
        }
        return c.json(
          {
            error: error.code,
            detail: error.message,
            remediation: error.remediation,
          },
          502,
        );
      }
      throw error;
    }
  });
