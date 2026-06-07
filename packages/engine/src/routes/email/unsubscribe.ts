import type { UnsubscribeTokenPayload } from "@hogsend/email";
import {
  generatePreferenceCenterUrl,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { htmlPage } from "../../lib/html.js";
import { upsertEmailPreference } from "../../lib/preferences.js";

const unsubscribeRoute = createRoute({
  method: "get",
  path: "/unsubscribe",
  tags: ["Email"],
  summary: "Unsubscribe from emails",
  request: {
    query: z.object({
      token: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "text/html": { schema: z.string() } },
      description: "Unsubscribe confirmation",
    },
    400: {
      content: { "text/html": { schema: z.string() } },
      description: "Invalid or expired token",
    },
  },
});

export const unsubscribeRouter = new OpenAPIHono<AppEnv>().openapi(
  unsubscribeRoute,
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

    const { externalId, email, category, action } = payload;

    if (category && !/^[a-z0-9_-]+$/i.test(category)) {
      return c.html(
        htmlPage({
          title: "Invalid Link",
          body: "<h1>Invalid category</h1><p>This link is malformed.</p>",
        }),
        400,
      );
    }

    if (action === "resubscribe") {
      await upsertEmailPreference({
        db,
        externalId,
        email,
        update: category
          ? {
              categoryKey: category,
              categoryValue: true,
              unsubscribedAll: false,
            }
          : { unsubscribedAll: false },
      });

      return c.html(
        htmlPage({
          title: "Resubscribed",
          body: `<h1>You're back!</h1><p>You've been resubscribed${category ? ` to <strong>${category}</strong> emails` : ""}.</p>`,
        }),
        200,
      );
    }

    await upsertEmailPreference({
      db,
      externalId,
      email,
      update: category
        ? { categoryKey: category, categoryValue: false }
        : { unsubscribedAll: true },
    });

    const preferenceCenterUrl = generatePreferenceCenterUrl({
      baseUrl: env.API_PUBLIC_URL,
      secret: env.BETTER_AUTH_SECRET,
      externalId,
      email,
    });

    return c.html(
      htmlPage({
        title: "Unsubscribed",
        body: `<h1>You've been unsubscribed</h1>
        <p>You won't receive ${category ? `<strong>${category}</strong>` : "any more"} emails from us.</p>
        <p><a href="${preferenceCenterUrl}">Manage your email preferences</a></p>`,
      }),
      200,
    );
  },
);
