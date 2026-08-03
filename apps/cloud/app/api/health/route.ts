import { checkCloudHealth } from "@/src/db/health";
import { env } from "@/src/env";

// Health reflects live database state; caching or prerendering it would serve a
// stale verdict.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const health = await checkCloudHealth(env.CLOUD_DATABASE_URL);
  // Always 200: the BODY carries the verdict. A non-2xx here would make an
  // orchestrator restart-loop the app over a database it cannot fix by
  // restarting.
  return Response.json(health, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
