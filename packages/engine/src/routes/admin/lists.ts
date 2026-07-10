import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { getListRegistry } from "../../lists/registry-singleton.js";

const listSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  defaultOptIn: z.boolean(),
  enabled: z.boolean(),
  // `"topic"` = author-defined (`defineList`); `"channel"` = engine-synthesized
  // delivery channel (the in-app feed + one per member-directed connector).
  kind: z.enum(["channel", "topic"]),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Lists"],
  summary: "List all registered lists",
  description:
    "Returns EVERY registered list — author-defined topics AND engine-synthesized channels — with its `kind`. Reads the process `ListRegistry` directly (no DB); mirrors the catalog the mailer and preference center resolve against.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ lists: z.array(listSchema) }),
        },
      },
      description: "All registered lists (topics + channels)",
    },
  },
});

export const adminListsRouter = new OpenAPIHono<AppEnv>().openapi(
  listRoute,
  (c) => {
    const lists = getListRegistry()
      .getAll()
      .map((l) => ({
        id: l.id,
        name: l.name,
        ...(l.description !== undefined ? { description: l.description } : {}),
        defaultOptIn: l.defaultOptIn,
        enabled: l.enabled,
        kind: l.kind ?? "topic",
      }));

    return c.json({ lists }, 200);
  },
);
