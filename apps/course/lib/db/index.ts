import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * Postgres-js + Drizzle client for the course's own database. The connection is
 * lazy (no TCP until the first query), so importing at build time is safe — the
 * build-phase placeholder from lib/env is never connected to (no query runs on a
 * static/free page). At runtime Railway injects DATABASE_URL (a private ref to
 * the dedicated course Postgres); lib/env throws if it's missing at runtime.
 *
 * Migrations run from scripts/migrate.mjs (esbuild-bundled at build into a
 * self-contained migrate.bundle.mjs for the Railway pre-deploy step) — not from
 * here, so this module needs no migrator re-export.
 */
const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });
