import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { getBootDiagnostics } from "../../lib/boot-diagnostics.js";

/**
 * Boot-time configuration diagnostics, FULL DETAIL. This is the admin half of
 * the split: the unauthenticated `/v1/health` exposes only the COUNT, because
 * these messages name unset env vars, absent secrets and unauthenticated
 * contact sources — deployment reconnaissance. Auth comes from the admin
 * router's `use("*", requireAdmin)`; this router deliberately mounts nothing
 * of its own.
 */

const bootDiagnosticSchema = z.object({
  /** Stable, namespaced, machine-readable identifier (the dedupe key). */
  code: z.string(),
  /** Human-readable detail — may name env vars; that is why it lives here. */
  message: z.string(),
});

const configResponseSchema = z.object({
  warnings: z.array(bootDiagnosticSchema),
});

const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Config"],
  summary: "Boot-time configuration diagnostics (full detail)",
  responses: {
    200: {
      content: { "application/json": { schema: configResponseSchema } },
      description: "Every recorded boot diagnostic, code and message",
    },
  },
});

export const configRouter = new OpenAPIHono<AppEnv>().openapi(
  getConfigRoute,
  (c) => {
    // Spread: the collector hands out a readonly snapshot; the response wants
    // a plain mutable array type.
    return c.json({ warnings: [...getBootDiagnostics()] }, 200);
  },
);
