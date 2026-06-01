import { contacts, type Database, type emailPreferences } from "@hogsend/db";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function contactWhereClause(id: string) {
  return UUID_REGEX.test(id)
    ? eq(contacts.id, id)
    : eq(contacts.externalId, id);
}

export async function resolveContact(opts: { db: Database; id: string }) {
  const { db, id } = opts;
  const rows = await db
    .select()
    .from(contacts)
    .where(and(contactWhereClause(id), isNull(contacts.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export function serializePrefs(row: typeof emailPreferences.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    unsubscribedAll: row.unsubscribedAll,
    suppressed: row.suppressed,
    bounceCount: row.bounceCount,
    categories: (row.categories ?? {}) as Record<string, boolean>,
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    lastBounceAt: row.lastBounceAt?.toISOString() ?? null,
  };
}

export function contactSearchFilter(search: string) {
  return or(
    ilike(contacts.email, `%${search}%`),
    ilike(contacts.externalId, `%${search}%`),
  );
}

export async function upsertContact(opts: {
  db: Database;
  externalId: string;
  email?: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const { db, externalId, email, properties } = opts;

  await db
    .insert(contacts)
    .values({
      externalId,
      email: email || null,
      properties: properties ?? {},
    })
    .onConflictDoUpdate({
      target: contacts.externalId,
      set: {
        ...(email ? { email } : {}),
        properties: sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(properties ?? {})}::jsonb`,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
}
