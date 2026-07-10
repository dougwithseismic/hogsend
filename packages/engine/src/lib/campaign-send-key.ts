/**
 * The deterministic per-recipient idempotency key a campaign send writes to
 * `email_sends.idempotency_key` (`campaign:<campaignId>:<email>`). This key is
 * ALSO how a send row is attributed back to its campaign (there is no
 * campaign_id FK on email_sends), so the format is owned here — the
 * send-campaign task mints keys with `campaignSendKey` and the admin
 * campaign-stats/sends routes match them with `campaignSendKeyPattern`.
 */
export function campaignSendKey(campaignId: string, email: string): string {
  return `campaign:${campaignId}:${email}`;
}

/**
 * SQL LIKE pattern matching every send of one campaign. The id is escaped so
 * LIKE metacharacters in it can't widen the match (ids are UUIDs today, but
 * the route accepts arbitrary strings).
 */
export function campaignSendKeyPattern(campaignId: string): string {
  return `campaign:${campaignId.replace(/([\\%_])/g, "\\$1")}:%`;
}
