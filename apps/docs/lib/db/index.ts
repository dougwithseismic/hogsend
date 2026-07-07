import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * Postgres-js + Drizzle client for the SHARED user database (the course's
 * Postgres — docs connects to the same DATABASE_URL so sessions are portable
 * across `*.hogsend.com`). The connection is lazy (no TCP until the first
 * query), so importing at build time is safe — the build-phase placeholder from
 * lib/env is never connected to. At runtime lib/env throws if DATABASE_URL is
 * missing, so the auth routes fail closed rather than talk to a placeholder DB.
 *
 * docs only ever reads/writes the four Better Auth models; migrations are owned
 * by the course (this module has no migrator).
 *
 * In dev the client is cached on globalThis so Turbopack hot-reload doesn't leak
 * a fresh pool on every edit until max_connections is exhausted. Production
 * evaluates once, so the cache is a no-op there.
 */
const globalForDb = globalThis as { __docsPg?: ReturnType<typeof postgres> };
const client = globalForDb.__docsPg ?? postgres(env.DATABASE_URL);
if (process.env.NODE_ENV !== "production") globalForDb.__docsPg = client;

export const db = drizzle(client, { schema });
