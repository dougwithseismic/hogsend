import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { getListRegistry } from "../../lists/registry-singleton.js";

const listSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  defaultOptIn: z.boolean(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  summary: "List defined email lists",
  description:
    "Returns the enabled, code-defined email lists (D3). Membership lives in `email_preferences.categories`; this only enumerates the catalog.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ lists: z.array(listSummarySchema) }),
        },
      },
      description: "Enabled lists",
    },
  },
});

export const listListRouter = new OpenAPIHono<AppEnv>().openapi(
  listRoute,
  (c) => {
    const lists = getListRegistry()
      .getEnabled()
      .map((l) => ({
        id: l.id,
        name: l.name,
        ...(l.description !== undefined ? { description: l.description } : {}),
        defaultOptIn: l.defaultOptIn,
      }));

    return c.json({ lists }, 200);
  },
);
