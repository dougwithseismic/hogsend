import { auditLogs } from "@hogsend/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function extractResource(path: string): {
  resource: string;
  resourceId: string | null;
} {
  const parts = path
    .replace(/^\/v1\/admin\//, "")
    .split("/")
    .filter(Boolean);

  const resource = parts[0] ?? "unknown";
  const resourceId = parts[1] ?? null;
  return { resource, resourceId };
}

export const auditMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  if (!MUTATION_METHODS.has(c.req.method)) return;
  if (c.res.status >= 400) return;

  const apiKey = c.get("apiKey");
  const { db, logger } = c.get("container");
  const { resource, resourceId } = extractResource(c.req.path);

  db.insert(auditLogs)
    .values({
      actor: apiKey?.name ?? "unknown",
      actorKeyId: apiKey?.id && apiKey.id !== "legacy" ? apiKey.id : null,
      action: `${resource}.${c.req.method.toLowerCase()}`,
      resource,
      resourceId,
      ipAddress:
        c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    })
    .then(() => {})
    .catch((err: unknown) => {
      logger.warn("Audit log write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
});
