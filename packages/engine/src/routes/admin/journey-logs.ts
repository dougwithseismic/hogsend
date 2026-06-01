import { journeyLogs, journeyStates } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const stateSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  journeyId: z.string(),
  currentNodeId: z.string(),
  status: z.string(),
  hatchetRunId: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
  errorMessage: z.string().nullable(),
  entryCount: z.number(),
  completedAt: z.string().nullable(),
  exitedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const logSchema = z.object({
  id: z.string(),
  fromNodeId: z.string().nullable(),
  toNodeId: z.string().nullable(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

import { errorSchema } from "../../lib/schemas.js";

function serializeState(row: typeof journeyStates.$inferSelect) {
  return {
    ...row,
    context: (row.context ?? {}) as Record<string, unknown>,
    completedAt: row.completedAt?.toISOString() ?? null,
    exitedAt: row.exitedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeLog(row: typeof journeyLogs.$inferSelect) {
  return {
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    action: row.action,
    detail: (row.detail ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  };
}

const getRoute = createRoute({
  method: "get",
  path: "/{stateId}",
  tags: ["Admin — Journey Logs"],
  summary: "Get full log sequence for a journey instance",
  request: {
    params: z.object({ stateId: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            state: stateSchema,
            logs: z.array(logSchema),
          }),
        },
      },
      description: "Journey instance with full log sequence",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey state not found",
    },
  },
});

export const journeyLogsRouter = new OpenAPIHono<AppEnv>().openapi(
  getRoute,
  async (c) => {
    const { db } = c.get("container");
    const { stateId } = c.req.valid("param");

    const [stateRows, logs] = await Promise.all([
      db
        .select()
        .from(journeyStates)
        .where(
          and(eq(journeyStates.id, stateId), isNull(journeyStates.deletedAt)),
        )
        .limit(1),
      db
        .select()
        .from(journeyLogs)
        .where(eq(journeyLogs.journeyStateId, stateId))
        .orderBy(journeyLogs.createdAt),
    ]);

    const state = stateRows[0];
    if (!state) {
      return c.json({ error: "Journey state not found" }, 404);
    }

    return c.json(
      {
        state: serializeState(state),
        logs: logs.map(serializeLog),
      },
      200,
    );
  },
);
