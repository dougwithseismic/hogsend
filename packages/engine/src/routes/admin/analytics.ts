import { DEFAULT_HOST, derivePrivateHost } from "@hogsend/plugin-posthog";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { createTokenManager } from "../../lib/oauth-token-manager.js";
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
});
export type ConnectInfo = z.infer<typeof connectInfoSchema>;

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
        "at all), or `webhook_secret_missing` (POSTHOG_WEBHOOK_SECRET unset)",
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
  .openapi(connectInfoRoute, (c) => {
    return c.json(resolveConnectInfo(c.get("container").env), 200);
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
        webhookSecret: env.POSTHOG_WEBHOOK_SECRET,
        logger,
      });

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
