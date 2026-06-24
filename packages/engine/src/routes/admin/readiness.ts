import { apiKeys } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { count, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * First-time setup readiness — a NON-BLOCKING checklist for Studio's Setup view.
 * It reports per-area configuration state ("done", "needs action", "optional")
 * so a fresh operator sees what's left to wire (email key, sending domain,
 * data-plane key, analytics) without anything erroring or gating the UI. It is
 * deliberately read-only and best-effort: a single failing probe degrades that
 * one row, never the whole response.
 */

const DOCS = "https://docs.hogsend.com";
/** The env.example placeholder — a present-but-unset Resend key. */
const RESEND_PLACEHOLDER = "re_your_api_key_here";

const checkSchema = z.object({
  id: z.string(),
  label: z.string(),
  // "ok" satisfied · "action" recommended + not done · "optional" nice-to-have
  status: z.enum(["ok", "action", "optional"]),
  detail: z.string(),
  docsUrl: z.string().optional(),
});

type Check = z.infer<typeof checkSchema>;

const readinessSchema = z.object({
  /** true when nothing is left in the "action" state (optional rows may remain). */
  ready: z.boolean(),
  doneCount: z.number(),
  totalCount: z.number(),
  checks: z.array(checkSchema),
});

const getReadinessRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Readiness"],
  summary: "First-time setup readiness checklist (non-blocking)",
  responses: {
    200: {
      content: { "application/json": { schema: readinessSchema } },
      description: "Per-area setup readiness for the Studio Setup checklist",
    },
  },
});

export const readinessRouter = new OpenAPIHono<AppEnv>().openapi(
  getReadinessRoute,
  async (c) => {
    const { env, db, emailProvider, analytics, domainStatus } =
      c.get("container");
    const checks: Check[] = [];

    // 1. Studio admin — you must be one to reach this guarded route, so it's
    //    trivially satisfied; surfaced anyway as reassurance in the checklist.
    checks.push({
      id: "studio_admin",
      label: "Studio admin",
      status: "ok",
      detail: "Signed in.",
    });

    // 2. Hatchet — required at boot, so reaching here means it's connected.
    checks.push({
      id: "hatchet",
      label: "Hatchet worker engine",
      status: env.HATCHET_CLIENT_TOKEN ? "ok" : "action",
      detail: env.HATCHET_CLIENT_TOKEN
        ? `Connected (${env.HATCHET_CLIENT_HOST_PORT}).`
        : "Set HATCHET_CLIENT_TOKEN so the worker can run your journeys.",
      docsUrl: DOCS,
    });

    // 3. Email provider key — sends fail without it.
    const providerId = emailProvider.meta?.id ?? "email";
    const providerKeyPresent =
      providerId === "resend"
        ? Boolean(env.RESEND_API_KEY) &&
          env.RESEND_API_KEY !== RESEND_PLACEHOLDER
        : providerId === "postmark"
          ? Boolean(env.POSTMARK_SERVER_TOKEN)
          : // A custom provider was constructed with its own credentials.
            true;
    checks.push({
      id: "email_provider",
      label: "Email provider",
      status: providerKeyPresent ? "ok" : "action",
      detail: providerKeyPresent
        ? `${providerId} key configured.`
        : `No ${providerId} API key yet — sends will fail until one is set.`,
      docsUrl: DOCS,
    });

    // 4. Data-plane API key — any non-revoked key lets your app code ingest.
    let dataPlaneKeys = 0;
    try {
      const [row] = await db
        .select({ n: count() })
        .from(apiKeys)
        .where(isNull(apiKeys.revokedAt));
      dataPlaneKeys = Number(row?.n ?? 0);
    } catch {
      // DB hiccup — degrade this one row, don't fail the whole checklist.
    }
    checks.push({
      id: "data_plane_key",
      label: "Data-plane API key",
      status: dataPlaneKeys > 0 ? "ok" : "action",
      detail:
        dataPlaneKeys > 0
          ? `${dataPlaneKeys} active key${dataPlaneKeys === 1 ? "" : "s"}.`
          : "Mint one (run bootstrap, or POST /v1/admin/api-keys) so your app can send events.",
      docsUrl: DOCS,
    });

    // 5. Sending domain — derive from the (now graceful) domain status. A bad
    //    provider key no longer throws here; it surfaces as status === null.
    try {
      const dom = await domainStatus.getStatus();
      if (!dom.domain) {
        checks.push({
          id: "sending_domain",
          label: "Sending domain",
          status: "optional",
          detail:
            "No EMAIL_DOMAIN set — sends use the provider default. Configure one to send from your own domain.",
          docsUrl: DOCS,
        });
      } else if (dom.status?.state === "verified") {
        checks.push({
          id: "sending_domain",
          label: "Sending domain",
          status: "ok",
          detail: `${dom.domain} verified.`,
        });
      } else {
        checks.push({
          id: "sending_domain",
          label: "Sending domain",
          status: "action",
          detail:
            dom.status === null
              ? `${dom.domain}: can't read status — confirm your ${providerId} key can read domains.`
              : `${dom.domain} is ${dom.status.state.replace("_", " ")} — verify it below.`,
          docsUrl: DOCS,
        });
      }
    } catch {
      checks.push({
        id: "sending_domain",
        label: "Sending domain",
        status: "action",
        detail: "Couldn't read domain status — check your email provider key.",
        docsUrl: DOCS,
      });
    }

    // 6. PostHog analytics — optional.
    const analyticsConfigured =
      Boolean(env.POSTHOG_API_KEY) || Boolean(analytics);
    checks.push({
      id: "analytics",
      label: "PostHog analytics",
      status: analyticsConfigured ? "ok" : "optional",
      detail: analyticsConfigured
        ? "Connected."
        : "Optional — connect PostHog to capture events and person properties.",
      docsUrl: DOCS,
    });

    const doneCount = checks.filter((ch) => ch.status === "ok").length;
    // "ready" ignores optional rows — only outstanding "action" items block it.
    const ready = checks.every((ch) => ch.status !== "action");

    return c.json({ ready, doneCount, totalCount: checks.length, checks }, 200);
  },
);
