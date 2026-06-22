import { DISCORD_API_BASE } from "../constants.js";

/**
 * Edit the ORIGINAL response of a deferred interaction.
 *
 * The deferred email-modal-submit step (`/link` email → mint a cold-connect
 * confirm token + email the one-click confirm LINK) returns a type-5 ack inside
 * Discord's hard 3-second window and then does its real work — the
 * anti-email-bomb throttle, the token mint, the provider HTTP send — out of band.
 * When that work resolves, this PATCHes the deferred "thinking…" message into the
 * final ephemeral reply via Discord's interaction-webhook endpoint
 * (`PATCH /webhooks/{applicationId}/{token}/messages/@original`).
 *
 * The PATCH authenticates with the APPLICATION ID + the per-interaction TOKEN
 * ONLY — NO bot token, no Authorization header (this is the interaction-webhook
 * endpoint, not the bot REST API). The body is a full message body — the
 * link-confirm flow only ever edits `content` (the button-less "check your inbox"
 * message and the failure replies); there is no longer a button/component edit.
 *
 * The interaction token is short-lived (Discord allows ~15 min of follow-ups);
 * a deferred reply edited well within that window always lands. The call is
 * best-effort: a failed PATCH leaves the user on the "thinking…" state, so the
 * caller logs (never throws) — the confirm link is already minted+emailed
 * regardless.
 *
 * SECRET HYGIENE: the `token` authenticates the follow-up; it is NEVER logged.
 * On a non-2xx we surface ONLY the HTTP status, never the response body (which
 * could echo request material).
 */
export async function editInteractionResponse(args: {
  applicationId: string;
  /** The interaction token from the original payload — authenticates the edit. */
  token: string;
  /** Full message body — `{ content?, components?, flags? }`. */
  body: Record<string, unknown>;
}): Promise<void> {
  const url =
    `${DISCORD_API_BASE}/webhooks/${args.applicationId}/${args.token}` +
    "/messages/@original";
  // RACE: the deferred (type-5) ack is delivered by the engine route AFTER this
  // handler returns, so a fast follow-up (work resolved in <1s) can reach Discord
  // BEFORE it has registered the deferral — the @original message then 404s ("not
  // ready yet"). Retry ONLY the 404 with short backoff; it lands as soon as the
  // deferral registers (well within the 15-min token window). Any other status
  // fails fast (a real error, not a timing artifact).
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args.body),
    });
    if (res.ok) return;
    if (res.status === 404 && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      continue;
    }
    throw new Error(`discord interaction follow-up failed (${res.status})`);
  }
}
