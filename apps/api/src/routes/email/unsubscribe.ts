import { emailPreferences } from "@hogsend/db";
import type { UnsubscribeTokenPayload } from "@hogsend/email";
import {
  generatePreferenceCenterUrl,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

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

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #555; line-height: 1.6; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export const unsubscribeRouter = new OpenAPIHono<AppEnv>().openapi(
  unsubscribeRoute,
  async (c) => {
    const { token } = c.req.valid("query");
    const { env, db } = c.get("container");

    let payload: UnsubscribeTokenPayload;
    try {
      payload = validateUnsubscribeToken(token, env.BETTER_AUTH_SECRET);
    } catch (err) {
      const message =
        err instanceof InvalidTokenError ? err.message : "Invalid token";
      return c.html(
        htmlPage(
          "Invalid Link",
          `<h1>This link is no longer valid</h1><p>${message}. Please check your email for a newer link.</p>`,
        ),
        400,
      );
    }

    const { externalId, email, category, action } = payload;

    if (action === "resubscribe") {
      if (category) {
        await db
          .insert(emailPreferences)
          .values({
            userId: externalId,
            email,
            categories: { [category]: true },
          })
          .onConflictDoUpdate({
            target: [emailPreferences.userId, emailPreferences.email],
            set: {
              categories: sql`jsonb_set(COALESCE(${emailPreferences.categories}, '{}'::jsonb), ${`{${category}}`}, 'true')`,
              unsubscribedAll: false,
              updatedAt: new Date(),
            },
          });
      } else {
        await db
          .insert(emailPreferences)
          .values({
            userId: externalId,
            email,
            unsubscribedAll: false,
          })
          .onConflictDoUpdate({
            target: [emailPreferences.userId, emailPreferences.email],
            set: {
              unsubscribedAll: false,
              updatedAt: new Date(),
            },
          });
      }

      return c.html(
        htmlPage(
          "Resubscribed",
          `<h1>You're back!</h1><p>You've been resubscribed${category ? ` to <strong>${category}</strong> emails` : ""}.</p>`,
        ),
        200,
      );
    }

    if (category) {
      await db
        .insert(emailPreferences)
        .values({
          userId: externalId,
          email,
          categories: { [category]: false },
        })
        .onConflictDoUpdate({
          target: [emailPreferences.userId, emailPreferences.email],
          set: {
            categories: sql`jsonb_set(COALESCE(${emailPreferences.categories}, '{}'::jsonb), ${`{${category}}`}, 'false')`,
            updatedAt: new Date(),
          },
        });
    } else {
      await db
        .insert(emailPreferences)
        .values({
          userId: externalId,
          email,
          unsubscribedAll: true,
        })
        .onConflictDoUpdate({
          target: [emailPreferences.userId, emailPreferences.email],
          set: {
            unsubscribedAll: true,
            updatedAt: new Date(),
          },
        });
    }

    const preferenceCenterUrl = generatePreferenceCenterUrl({
      baseUrl: env.API_PUBLIC_URL,
      secret: env.BETTER_AUTH_SECRET,
      externalId,
      email,
    });

    return c.html(
      htmlPage(
        "Unsubscribed",
        `<h1>You've been unsubscribed</h1>
        <p>You won't receive ${category ? `<strong>${category}</strong>` : "any more"} emails from us.</p>
        <p><a href="${preferenceCenterUrl}">Manage your email preferences</a></p>`,
      ),
      200,
    );
  },
);
