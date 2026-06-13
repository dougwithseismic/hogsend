import { DISCORD_API_BASE } from "../constants.js";

/**
 * Edit the ORIGINAL response of a deferred interaction.
 *
 * The `/link` command DEFERS (returns a type-5 ack inside Discord's hard 3-second
 * window) and then does its real work — the anti-email-bomb throttle, the code
 * mint, and the provider HTTP send — out of band. When that work resolves, this
 * PATCHes the deferred "thinking…" message into the final ephemeral reply via
 * Discord's interaction-webhook endpoint
 * (`PATCH /webhooks/{applicationId}/{token}/messages/@original`).
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
  /** Ephemeral message content to render in place of the deferred ack. */
  content: string;
}): Promise<void> {
  const url =
    `${DISCORD_API_BASE}/webhooks/${args.applicationId}/${args.token}` +
    "/messages/@original";
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: args.content }),
  });
  if (!res.ok) {
    throw new Error(`discord interaction follow-up failed (${res.status})`);
  }
}
