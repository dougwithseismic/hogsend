import { durationToMs } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailSends } from "@hogsend/db";
import { and, count, eq, gte, ne } from "drizzle-orm";
import type { FrequencyCapConfig } from "./email-service-types.js";

const DEFAULT_EXEMPT = ["transactional"];

/**
 * True if this recipient has hit the configured send cap within the window.
 *
 * - `config` undefined → false (feature is opt-in; safe default = no cap).
 * - An exempt `category` (default "transactional") → false.
 * - A `byCategory[category]` override uses its own count/window AND filters the
 *   COUNT by that category; otherwise the global rule counts ALL of the
 *   recipient's non-failed sends in the window (NULL-category rows included).
 *
 * The COUNT is served by `email_sends_freq_cap_idx (to_email, created_at,
 * category)`. Never-dispatched / failed rows (`status = 'failed'`) are excluded.
 */
export async function isFrequencyCapped(opts: {
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
    eq(emailSends.toEmail, to),
    gte(emailSends.createdAt, since),
    ne(emailSends.status, "failed"),
  ];
  // The byCategory branch counts only sends in that category.
  if (override && category) {
    conditions.push(eq(emailSends.category, category));
  }

  const [row] = await db
    .select({ n: count() })
    .from(emailSends)
    .where(and(...conditions));

  return (row?.n ?? 0) >= rule.count;
}
