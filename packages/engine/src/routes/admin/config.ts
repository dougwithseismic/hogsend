import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { getBootDiagnostics } from "../../lib/boot-diagnostics.js";
import { getWorkerHeartbeat } from "../../lib/worker-heartbeat.js";

/**
 * Boot-time configuration diagnostics, FULL DETAIL. This is the admin half of
 * the split: the unauthenticated `/v1/health` exposes only the COUNT, because
 * these messages name unset env vars, absent secrets and unauthenticated
 * contact sources — deployment reconnaissance. Auth comes from the admin
 * router's `use("*", requireAdmin)`; this router deliberately mounts nothing
 * of its own.
 *
 * Entries come from BOTH processes: the API's own collector, plus the
 * worker's collector as published on the Redis heartbeat payload (see
 * lib/worker-heartbeat.ts for why the boundary crossing exists at all). The
 * same code recorded by both appears as TWO rows here — deliberately, unlike
 * /v1/health's union-deduped count: Railway env is per-service, so the
 * process tag tells the operator WHICH service's env to fix.
 */

const bootDiagnosticSchema = z.object({
  /** Stable, namespaced, machine-readable identifier (the dedupe key). */
  code: z.string(),
  /** Human-readable detail — may name env vars; that is why it lives here. */
  message: z.string(),
  /**
   * Which OS process recorded the entry. The collector is per-process and
   * only the API serves HTTP; worker entries arrive via the Redis worker
   * heartbeat.
   */
  process: z.enum(["api", "worker"]),
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
      description:
        "Every recorded boot diagnostic — code, message, and the process " +
        "(api | worker) that recorded it",
    },
  },
});

export const configRouter = new OpenAPIHono<AppEnv>().openapi(
  getConfigRoute,
  async (c) => {
    // getWorkerHeartbeat never throws and races its own read deadline, so a
    // Redis outage, stale heartbeat or malformed payload degrades this route
    // to the API-only view instead of erroring.
    const worker = await getWorkerHeartbeat();
    return c.json(
      {
        warnings: [
          ...getBootDiagnostics().map((d) => ({
            ...d,
            process: "api" as const,
          })),
          ...(worker.diagnostics ?? []).map((d) => ({
            ...d,
            process: "worker" as const,
          })),
        ],
      },
      200,
    );
  },
);
