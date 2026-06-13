import { DISCORD_API_BASE } from "../constants.js";

/**
 * Edit the ORIGINAL response of a deferred interaction.
 *
 * The deferred modal-submit steps (`/link` email → mint+send; the code modal →
 * redeem+resolve) return a type-5 ack inside Discord's hard 3-second window and
 * then do their real work — the anti-email-bomb throttle, the code mint, the
 * provider HTTP send, the redeem + DB attach — out of band. When that work
 * resolves, this PATCHes the deferred "thinking…" message into the final
 * ephemeral reply via Discord's interaction-webhook endpoint
 * (`PATCH /webhooks/{applicationId}/{token}/messages/@original`).
 *
 * The PATCH authenticates with the APPLICATION ID + the per-interaction TOKEN
 * ONLY — NO bot token, no Authorization header (this is the interaction-webhook
 * endpoint, not the bot REST API). The body is a full message body so callers
 * can edit `content` (plain replies), `components` (the Enter-code button), or a
 * Components-V2 success card (`flags: 32832`).
 *
 * The interaction token is short-lived (Discord allows ~15 min of follow-ups);
 * a deferred reply edited well within that window always lands. The call is
 * best-effort: a failed PATCH leaves the user on the "thinking…" state, so the
 * caller logs (never throws) — the code is already minted+emailed regardless.
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
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.body),
  });
  if (!res.ok) {
    throw new Error(`discord interaction follow-up failed (${res.status})`);
  }
}
