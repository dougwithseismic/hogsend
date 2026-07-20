/**
 * The deterministic per-recipient idempotency key a campaign send writes to
 * `email_sends.idempotency_key`. The key exists for DEDUP; campaign
 * attribution is the `email_sends.campaign_id` column (stamped on every
 * campaign-dispatched row including suppressed sends, which write no key at
 * all; legacy rows backfilled by migration 0051). The one thing the key
 * still uniquely carries is the STEP NUMBER of a multi-step campaign, which
 * is why the per-step stats breakdown matches `campaignStepSendKeyPattern`
 * (scoped to the campaign_id FK first).
 *
 * Two formats, chosen by the campaign's step count (NOT per call site):
 *
 *  - Single-step campaigns (steps.length === 1 or a NULL steps blob) ALWAYS
 *    use the legacy `campaign:<id>:<email>` — behavior and any in-flight
 *    campaign at deploy time are byte-for-byte unchanged.
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
