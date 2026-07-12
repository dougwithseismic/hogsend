import { durationToMs } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { voiceCalls } from "@hogsend/db";
import { and, count, eq, gte, ne } from "drizzle-orm";
import type { FrequencyCapConfig } from "./email-service-types.js";

const DEFAULT_EXEMPT = ["transactional"];

/**
 * The voice sibling of {@link isSmsFrequencyCapped}: true if this recipient has
 * hit the configured call cap within the window, counted over `voice_calls` by
 * `to_number` (served by `voice_calls_freq_cap_idx`). Kept SEPARATE from the
 * email + SMS caps so no channel's budget consumes another's. Failed calls are
 * excluded; an exempt category (default "transactional") short-circuits.
 */
export async function isVoiceFrequencyCapped(opts: {
  db: Database;
  to: string;
  category?: string;
  config?: FrequencyCapConfig;
}): Promise<boolean> {
  const { db, to, category, config } = opts;
  if (!config) return false;

  const exempt = config.exemptCategories ?? DEFAULT_EXEMPT;
  if (category && exempt.includes(category)) return false;

  const rule = { count: config.count, window: config.window };
  const since = new Date(Date.now() - durationToMs(rule.window));

  const [row] = await db
    .select({ n: count() })
    .from(voiceCalls)
    .where(
      and(
        eq(voiceCalls.toNumber, to),
        gte(voiceCalls.createdAt, since),
        ne(voiceCalls.status, "failed"),
      ),
    );

  return (row?.n ?? 0) >= rule.count;
}
