/**
 * The dumb relay client: the long-lived gateway worker POSTs each raw Discord
 * Gateway dispatch to the connector's own ingress
 * (`POST /v1/connectors/discord/ingress`) behind the shared internal secret,
 * so ALL transform logic stays in the connector and the socket worker carries
 * none of it. `fetch`-only; zero `discord.js`.
 */

import { DISCORD_PROVIDER_ID } from "../constants.js";

export interface PostToIngressArgs {
  /** Public base URL of the engine API instance. */
  apiPublicUrl: string;
  /** Shared internal secret (`CONNECTOR_INGRESS_SECRET`). */
  ingressSecret: string;
  /** The raw Discord dispatch type (the `t` on a Gateway frame). */
  dispatchType: string;
  /** The raw Discord dispatch `d` payload, forwarded untouched. */
  data: unknown;
}

export interface PostToIngressResult {
  ok: boolean;
  status: number;
}

/**
 * Forward one dispatch to the connector ingress. Wraps the payload as
 * `{ __t, d }` — the exact shape the connector transform unwraps. The shared
 * secret rides the `x-hogsend-ingress-secret` header (the ingress route
 * fails CLOSED when it is unset/mismatched).
 */
export async function postToIngress(
  args: PostToIngressArgs,
): Promise<PostToIngressResult> {
  const url =
    `${args.apiPublicUrl.replace(/\/$/, "")}` +
    `/v1/connectors/${DISCORD_PROVIDER_ID}/ingress`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hogsend-ingress-secret": args.ingressSecret,
    },
    body: JSON.stringify({ __t: args.dispatchType, d: args.data }),
  });

  return { ok: res.ok, status: res.status };
}
