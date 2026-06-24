/**
 * Pure unfurl-bot + prefetch detection for the click route.
 *
 * Link-preview bots (Discord, Slack, Telegram, Twitter, Facebook, …) AUTO-FETCH
 * any URL the moment it is DM'd/posted — BEFORE a human ever clicks — to render
 * a preview card. Browser/email prefetch does the same. We still record the
 * click + 302 for those hits (they ARE a fetch of the redirect), but we must NOT
 * re-ingest them onto the journey bus: otherwise a single personal link DM'd in
 * Discord would phantom-enroll the recipient before they act. This is the
 * load-bearing guard for the Discord/connector campaign use case.
 *
 * Kept pure (no Hono dependency) so it is trivially unit-testable and reusable.
 */
const BOT_UA_RE =
  /Discordbot|Slackbot|Slack-ImgProxy|Twitterbot|TelegramBot|facebookexternalhit|WhatsApp|LinkedInBot|SkypeUriPreview|Googlebot|GoogleImageProxy|Feedfetcher|bingbot|redditbot/i;

export interface BotPrefetchHeaders {
  userAgent?: string | null;
  /** `Purpose` request header (Chrome/Safari prefetch). */
  purpose?: string | null;
  /** `X-Purpose` request header (Safari). */
  xPurpose?: string | null;
  /** `X-Moz` request header (Firefox prefetch — value `prefetch`). */
  xMozPrefetch?: string | null;
}

/**
 * True when the request looks like an automated unfurl bot or a speculative
 * prefetch rather than a real human click.
 */
export function isBotOrPrefetch(headers: BotPrefetchHeaders): boolean {
  const { userAgent, purpose, xPurpose, xMozPrefetch } = headers;
  if (userAgent && BOT_UA_RE.test(userAgent)) return true;
  const p = purpose?.toLowerCase();
  if (p === "prefetch" || p === "preview") return true;
  const xp = xPurpose?.toLowerCase();
  if (xp === "prefetch" || xp === "preview") return true;
  if (xMozPrefetch) return true;
  return false;
}
