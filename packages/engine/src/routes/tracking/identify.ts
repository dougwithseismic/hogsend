import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  InvalidIdentityTokenError,
  validateIdentityToken,
} from "../../lib/identity-token.js";

/**
 * Exchange a redirect identity token (`hs_t`) for the distinct id. Called by
 * the LANDING SITE's frontend (CORS is open app-wide) after the user arrives
 * from a tracked email link; the site then calls `posthog.identify` (or its
 * analytics equivalent) with the result — ideally gated behind whatever
 * analytics consent the site already operates under.
 *
 * Possession of a fresh signed token IS the authorization (the same trust
 * model as unsubscribe links): tokens are signed with BETTER_AUTH_SECRET,
 * expire after an hour, and resolve to nothing but the distinct id + send id.
 */
const identifyRoute = createRoute({
  method: "post",
  path: "/identify",
  tags: ["Tracking"],
  summary: "Exchange a redirect identity token for the distinct id",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ token: z.string().min(1).max(2048) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Resolved identity",
      content: {
        "application/json": {
          schema: z.object({
            distinctId: z.string(),
            emailSendId: z.string().optional(),
          }),
        },
      },
    },
    400: { description: "Invalid or expired token" },
  },
});

export const identifyRouter = new OpenAPIHono<AppEnv>().openapi(
  identifyRoute,
  async (c) => {
    const { token } = c.req.valid("json");
    const { env } = c.get("container");

    try {
      const payload = validateIdentityToken({
        token,
        secret: env.BETTER_AUTH_SECRET,
      });
      return c.json(
        { distinctId: payload.distinctId, emailSendId: payload.emailSendId },
        200,
      );
    } catch (err) {
      if (err instanceof InvalidIdentityTokenError) {
        return c.body(null, 400);
      }
      throw err;
    }
  },
);
