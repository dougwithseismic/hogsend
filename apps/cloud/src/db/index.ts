import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema/index";

/**
 * The cloud control plane's own Postgres pool — `CLOUD_DATABASE_URL`, never the
 * engine's `DATABASE_URL`.
 *
 * Cached on `globalThis` because Next's dev server re-evaluates modules on every
 * hot reload; without this each edit would leak a pool until Postgres refuses
 * new connections.
 */
const globalForDb = globalThis as unknown as {
  __hogsendCloudSql?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__hogsendCloudSql ??
  postgres(env.CLOUD_DATABASE_URL, {
    connection: { application_name: "hogsend-cloud" },
  });

if (env.NODE_ENV !== "production") globalForDb.__hogsendCloudSql = client;

export const sqlClient = client;
export const db = drizzle(client, { schema });
export type CloudDb = typeof db;
export { schema };
