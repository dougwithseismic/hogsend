import { contacts, type Database } from "@hogsend/db";
import { sql } from "drizzle-orm";

export async function upsertContact(
  db: Database,
  data: {
    externalId: string;
    email?: string;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  const { externalId, email, properties } = data;

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
