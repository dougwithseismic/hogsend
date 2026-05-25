import type { Database } from "@hogsend/db";
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
import { htmlPage } from "../../lib/html.js";

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

async function upsertPreference(
  db: Database,
  externalId: string,
  email: string,
  update: {
    unsubscribedAll?: boolean;
    categoryKey?: string;
    categoryValue?: boolean;
  },
) {
  const setClause: Record<string, unknown> = { updatedAt: new Date() };

  if (update.unsubscribedAll !== undefined) {
    setClause.unsubscribedAll = update.unsubscribedAll;
  }
  if (update.categoryKey !== undefined) {
    const jsonValue = update.categoryValue ? "true" : "false";
    setClause.categories = sql`jsonb_set(COALESCE(${emailPreferences.categories}, '{}'::jsonb), ${`{${update.categoryKey}}`}, ${jsonValue}::jsonb)`;
  }

  await db
    .insert(emailPreferences)
    .values({
      userId: externalId,
      email,
      ...(update.unsubscribedAll !== undefined
        ? { unsubscribedAll: update.unsubscribedAll }
        : {}),
      ...(update.categoryKey !== undefined
        ? {
            categories: { [update.categoryKey]: update.categoryValue ?? false },
          }
        : {}),
    })
    .onConflictDoUpdate({
      target: [emailPreferences.userId, emailPreferences.email],
      set: setClause,
    });
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

    if (category && !/^[a-z0-9_-]+$/i.test(category)) {
      return c.html(
        htmlPage(
          "Invalid Link",
          "<h1>Invalid category</h1><p>This link is malformed.</p>",
        ),
        400,
      );
    }

    if (action === "resubscribe") {
      await upsertPreference(
        db,
        externalId,
        email,
        category
          ? {
              categoryKey: category,
              categoryValue: true,
              unsubscribedAll: false,
            }
          : { unsubscribedAll: false },
      );

      return c.html(
        htmlPage(
          "Resubscribed",
          `<h1>You're back!</h1><p>You've been resubscribed${category ? ` to <strong>${category}</strong> emails` : ""}.</p>`,
        ),
        200,
      );
    }

    await upsertPreference(
      db,
      externalId,
      email,
      category
        ? { categoryKey: category, categoryValue: false }
        : { unsubscribedAll: true },
    );

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
