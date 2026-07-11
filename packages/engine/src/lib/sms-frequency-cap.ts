import { durationToMs } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { smsSends } from "@hogsend/db";
import { and, count, eq, gte, ne } from "drizzle-orm";
import type { FrequencyCapConfig } from "./email-service-types.js";

const DEFAULT_EXEMPT = ["transactional"];

/**
 * The SMS sibling of {@link isFrequencyCapped}: true if this recipient has hit
 * the configured send cap within the window, counted over `sms_sends` by
 * `to_phone` (served by `sms_sends_freq_cap_idx`). Kept SEPARATE from the email
 * cap so email and SMS budgets never consume each other. Failed rows are
 * excluded; an exempt category (default "transactional") short-circuits.
 */
export async function isSmsFrequencyCapped(opts: {
  db: Database;
  to: string;
  category?: string;
  config?: FrequencyCapConfig;
}): Promise<boolean> {
  const { db, to, category, config } = opts;
  if (!config) return false;

  const exempt = config.exemptCategories ?? DEFAULT_EXEMPT;
  if (category && exempt.includes(category)) return false;

  const override = category ? config.byCategory?.[category] : undefined;
  const rule = override ?? { count: config.count, window: config.window };
  const since = new Date(Date.now() - durationToMs(rule.window));

  const conditions = [
    eq(smsSends.toPhone, to),
    gte(smsSends.createdAt, since),
    ne(smsSends.status, "failed"),
  ];
  if (override && category) {
    conditions.push(eq(smsSends.category, category));
  }

  const [row] = await db
    .select({ n: count() })
    .from(smsSends)
    .where(and(...conditions));

  return (row?.n ?? 0) >= rule.count;
}
