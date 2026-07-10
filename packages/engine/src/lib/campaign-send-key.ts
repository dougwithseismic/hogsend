/**
 * The deterministic per-recipient idempotency key a campaign send writes to
 * `email_sends.idempotency_key`. This key is ALSO how a send row is
 * attributed back to its campaign (there is no campaign_id FK on
 * email_sends), so the format is owned here — the send-campaign task mints
 * keys with `campaignSendKey` and the admin campaign-stats/sends routes match
 * them with the pattern helpers.
 *
 * Two formats, chosen by the campaign's step count (NOT per call site):
 *
 *  - Single-step campaigns (steps.length === 1 or a NULL steps blob) ALWAYS
 *    use the legacy `campaign:<id>:<email>` — behavior, stats queries, and
 *    any in-flight campaign at deploy time are byte-for-byte unchanged.
 *  - Multi-step campaigns use `campaign:<id>:<step>:<email>` for ALL steps
 *    including 0. No ambiguity with the legacy format is possible (no
 *    multi-step campaign exists before this ships), and per-step stats
 *    filter on the step-scoped pattern.
 *
 * The key deliberately excludes any timezone bucket (phase 3): same
 * recipient + same step = same key, always.
 */
export function campaignSendKey(
  campaignId: string,
  email: string,
  step?: number,
): string {
  return step === undefined
    ? `campaign:${campaignId}:${email}`
    : `campaign:${campaignId}:${step}:${email}`;
}

/** Escape LIKE metacharacters so an id/step can't widen a pattern match. */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * SQL LIKE pattern matching every send of one campaign — a correct superset
 * of BOTH key formats (legacy and step-scoped), so campaign-level stats need
 * no format awareness. The id is escaped so LIKE metacharacters in it can't
 * widen the match (ids are UUIDs today, but the route accepts arbitrary
 * strings).
 */
export function campaignSendKeyPattern(campaignId: string): string {
  return `campaign:${escapeLike(campaignId)}:%`;
}

/**
 * SQL LIKE pattern matching every send of ONE step of a multi-step campaign
 * (`campaign:<id>:<step>:%`). Meaningless against legacy single-step keys —
 * callers only use it on campaigns with a steps blob.
 */
export function campaignStepSendKeyPattern(
  campaignId: string,
  step: number,
): string {
  return `campaign:${escapeLike(campaignId)}:${step}:%`;
}
