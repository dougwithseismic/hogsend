import { DISCORD_API_BASE } from "../constants.js";

/**
 * Wire the Discord application server-side via `PATCH /applications/@me` (Bot
 * auth). Sets the `interactions_endpoint_url` (and optional install params) so
 * a fresh app is fully provisioned without portal clicking.
 *
 * IMPORTANT: Discord validates `interactions_endpoint_url` by synchronously
 * PINGing it during the PATCH — the interactions route MUST be live and
 * publicly reachable first, or the PATCH 400s. The caller (the `wire` admin
 * route) refuses when `API_PUBLIC_URL` is loopback for exactly this reason.
 *
 * Idempotent: PATCHing the same values again is a no-op on Discord's side.
 */

export interface PatchApplicationArgs {
  /** Bot token (used as `Bot <token>` — application-level config edits). */
  botToken: string;
  /** Public interactions URL (…/v1/connectors/discord/interactions). */
  interactionsEndpointUrl: string;
  /** Optional in-app install params (scopes + permissions bitfield). */
  installParams?: { scopes: string[]; permissions: string };
}

export interface PatchApplicationResult {
  applicationId: string;
  interactionsEndpointUrl: string | null;
}

export async function patchApplication(
  args: PatchApplicationArgs,
): Promise<PatchApplicationResult> {
  const payload: Record<string, unknown> = {
    interactions_endpoint_url: args.interactionsEndpointUrl,
  };
  if (args.installParams) {
    payload.install_params = {
      scopes: args.installParams.scopes,
      permissions: args.installParams.permissions,
    };
  }

  const res = await fetch(`${DISCORD_API_BASE}/applications/@me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${args.botToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // SECRET HYGIENE — status + a short static reason ONLY. The error body can
    // echo back the request (carrying the `Bot` token) or app config; it is
    // NEVER interpolated into the thrown message or logged.
    throw new Error(`Discord PATCH /applications/@me failed (${res.status})`);
  }

  const app = (await res.json()) as {
    id: string;
    interactions_endpoint_url?: string | null;
  };
  return {
    applicationId: app.id,
    interactionsEndpointUrl: app.interactions_endpoint_url ?? null,
  };
}
