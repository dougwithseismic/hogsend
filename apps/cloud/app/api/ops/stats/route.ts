import { createHash, timingSafeEqual } from "node:crypto";
import { readOpsStats } from "@/src/lib/ops-stats";
import { bearerToken } from "@/src/lib/publish-guards";

// Live fleet state; caching or prerendering it would serve a stale verdict.
export const dynamic = "force-dynamic";

/**
 * Read from `process.env` per request rather than the validated `env` object:
 * the token is optional (so validation has nothing to enforce when absent) and
 * a lazy read lets tests toggle it without re-importing the module. env.ts
 * still declares CLOUD_OPS_TOKEN so a configured deploy validates its length.
 */
function configuredToken(): string | null {
  return process.env.CLOUD_OPS_TOKEN || null;
}

/** Constant-time, length-safe: compare digests, never the raw strings. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function fail(status: number, error: string, message: string): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const expected = configuredToken();
  // No token configured = no ops surface. 404, not 401, so an unconfigured
  // deploy does not even reveal the route exists.
  if (!expected) {
    return fail(404, "not_found", "Not found.");
  }

  const presented = bearerToken(request.headers);
  if (!presented || !tokenMatches(presented, expected)) {
    return fail(
      401,
      "invalid_token",
      "Send the operator token as `Authorization: Bearer <CLOUD_OPS_TOKEN>`.",
    );
  }

  return Response.json(await readOpsStats(), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
