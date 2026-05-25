import { type Database, emailSends } from "@hogsend/db";
import { count, gte, sql } from "drizzle-orm";

export interface EmailStatsResult {
  total: number;
  delivered: number;
  bounced: number;
  complained: number;
}

export async function getEmailStats(opts: {
  db: Database;
  since: Date;
}): Promise<EmailStatsResult> {
  const { db, since } = opts;
  const rows = await db
    .select({
      total: count(),
      delivered: sql<number>`count(*) filter (where ${emailSends.status} = 'delivered')`,
      bounced: sql<number>`count(*) filter (where ${emailSends.status} = 'bounced')`,
      complained: sql<number>`count(*) filter (where ${emailSends.status} = 'complained')`,
    })
    .from(emailSends)
    .where(gte(emailSends.createdAt, since));

  const row = rows[0];
  return {
    total: row?.total ?? 0,
    delivered: Number(row?.delivered ?? 0),
    bounced: Number(row?.bounced ?? 0),
    complained: Number(row?.complained ?? 0),
  };
}
