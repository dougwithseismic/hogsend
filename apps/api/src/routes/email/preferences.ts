import { emailPreferences } from "@hogsend/db";
import type { UnsubscribeTokenPayload } from "@hogsend/email";
import {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { htmlPage } from "../../lib/html.js";

const EMAIL_CATEGORIES = [
  { id: "journey", label: "Journey & lifecycle emails" },
] as const;

const preferencesRoute = createRoute({
  method: "get",
  path: "/preferences",
  tags: ["Email"],
  summary: "Email preference center",
  request: {
    query: z.object({
      token: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "Preference center page",
    },
    400: {
      content: { "text/html": { schema: z.string() } },
      description: "Invalid or expired token",
    },
  },
});

export const preferencesRouter = new OpenAPIHono<AppEnv>().openapi(
  preferencesRoute,
  async (c) => {
    const { token } = c.req.valid("query");
    const { env, db } = c.get("container");

    let payload: UnsubscribeTokenPayload;
    try {
      payload = validateUnsubscribeToken({
        token,
        secret: env.BETTER_AUTH_SECRET,
      });
    } catch (err) {
      const message =
        err instanceof InvalidTokenError ? err.message : "Invalid token";
      return c.html(
        htmlPage({
          title: "Invalid Link",
          body: `<h1>This link is no longer valid</h1><p>${message}. Please check your email for a newer link.</p>`,
        }),
        400,
      );
    }

    const { externalId, email } = payload;

    const rows = await db
      .select()
      .from(emailPreferences)
      .where(
        and(
          eq(emailPreferences.userId, externalId),
          eq(emailPreferences.email, email),
        ),
      )
      .limit(1);

    const prefs = rows[0];
    const categories = (prefs?.categories ?? {}) as Record<string, boolean>;
    const globalUnsub = prefs?.unsubscribedAll ?? false;

    function makeActionUrl(
      action: "unsubscribe" | "resubscribe",
      category?: string,
    ): string {
      const actionToken = generateUnsubscribeToken({
        secret: env.BETTER_AUTH_SECRET,
        externalId,
        email,
        action,
        category,
      });
      return `${env.API_PUBLIC_URL}/v1/email/unsubscribe?token=${encodeURIComponent(actionToken)}`;
    }

    let categoryRows = "";
    for (const cat of EMAIL_CATEGORIES) {
      const isSubscribed = categories[cat.id] !== false && !globalUnsub;
      const statusClass = isSubscribed ? "subscribed" : "unsubscribed";
      const statusText = isSubscribed ? "Subscribed" : "Unsubscribed";
      const actionLabel = isSubscribed ? "Unsubscribe" : "Resubscribe";
      const actionUrl = isSubscribed
        ? makeActionUrl("unsubscribe", cat.id)
        : makeActionUrl("resubscribe", cat.id);

      categoryRows += `
        <div class="pref-row">
          <div>
            <div class="pref-label">${cat.label}</div>
            <div class="pref-status ${statusClass}">${statusText}</div>
          </div>
          <a href="${actionUrl}">${actionLabel}</a>
        </div>`;
    }

    const globalStatusClass = globalUnsub ? "unsubscribed" : "subscribed";
    const globalStatusText = globalUnsub
      ? "Unsubscribed from all"
      : "Receiving emails";
    const globalActionLabel = globalUnsub
      ? "Resubscribe to all"
      : "Unsubscribe from all";
    const globalActionUrl = globalUnsub
      ? makeActionUrl("resubscribe")
      : makeActionUrl("unsubscribe");

    return c.html(
      htmlPage({
        title: "Email Preferences",
        body: `<h1>Email Preferences</h1>
        <p>Manage which emails you receive at <strong>${email}</strong>.</p>
        ${categoryRows}
        <div class="global-row">
          <div class="pref-row" style="border-bottom: none;">
            <div>
              <div class="pref-label">All emails</div>
              <div class="pref-status ${globalStatusClass}">${globalStatusText}</div>
            </div>
            <a href="${globalActionUrl}">${globalActionLabel}</a>
          </div>
        </div>`,
      }),
      200,
    );
  },
);
