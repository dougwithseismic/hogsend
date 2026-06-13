import { DISCORD_INTENTS } from "../constants.js";
import { DiscordEvents } from "../events.js";
import { postToIngress } from "./ingress.js";

/**
 * The long-lived Discord Gateway worker. It is its OWN entrypoint / Railway
 * service (NOT a Hatchet task): it holds a `discord.js` socket and forwards
 * every relevant raw dispatch to the connector ingress via {@link postToIngress}
 * so the transform stays server-side and this worker stays dumb.
 *
 * `discord.js` is an OPTIONAL peer, dynamically imported inside `start()` so the
 * engine API process (which imports the connector but never this file) never
 * loads a WebSocket client.
 */

export interface DiscordGatewayWorkerConfig {
  botToken: string;
  apiPublicUrl: string;
  ingressSecret: string;
  /** Which intents to request. Defaults to the privileged trio + base. */
  intents?: number;
}

export interface DiscordGatewayWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Forward one raw Gateway dispatch to the connector ingress. REAL + correct —
 * the live socket loop in `start()` calls exactly this on every `raw` packet.
 * Skips dispatch types the connector does not map (cheap pre-filter) and never
 * throws (a forward failure is logged, not fatal, so the socket stays up).
 */
async function forwardDispatch(
  config: DiscordGatewayWorkerConfig,
  packet: { t?: string | null; d?: unknown },
): Promise<void> {
  if (!packet.t || !(packet.t in DiscordEvents)) return;
  try {
    const result = await postToIngress({
      apiPublicUrl: config.apiPublicUrl,
      ingressSecret: config.ingressSecret,
      dispatchType: packet.t,
      data: packet.d,
    });
    if (!result.ok) {
      console.error(
        `discord ingress forward non-2xx (${result.status}) for ${packet.t}`,
      );
    }
  } catch (err) {
    console.error("discord ingress forward failed", err);
  }
}

export function createDiscordGatewayWorker(
  config: DiscordGatewayWorkerConfig,
): DiscordGatewayWorker {
  const intents =
    config.intents ??
    DISCORD_INTENTS.GUILDS |
      DISCORD_INTENTS.GUILD_MEMBERS |
      DISCORD_INTENTS.GUILD_MESSAGES |
      DISCORD_INTENTS.GUILD_MESSAGE_REACTIONS |
      DISCORD_INTENTS.GUILD_PRESENCES |
      DISCORD_INTENTS.MESSAGE_CONTENT;
  let client: unknown;

  async function start(): Promise<void> {
    // TODO(discord-gateway): wire the real discord.js socket loop. The ONLY
    // genuinely-stubbed part — needs a deployed long-lived process and
    // discord.js's WebSocket/heartbeat/RESUME machinery. The event→ingress
    // forwarding (forwardDispatch → postToIngress) is REAL and correct; only
    // the socket connect/handshake is stubbed. Real implementation:
    //
    //   const { Client } = await import("discord.js");
    //   client = new Client({ intents });
    //   (client as Client).on("raw", (packet: { t: string; d: unknown }) =>
    //     void forwardDispatch(config, packet),
    //   );
    //   await (client as Client).login(config.botToken);
    //
    // Until deployed, start() throws loudly so a misconfigured worker is never
    // silently dead. `intents`/`client`/`forwardDispatch` are referenced below
    // so the real wiring drops in without touching the surrounding code.
    void intents;
    void client;
    void config.botToken;
    void forwardDispatch;
    throw new Error(
      "createDiscordGatewayWorker: live socket loop not yet implemented — " +
        "see TODO(discord-gateway).",
    );
  }

  async function stop(): Promise<void> {
    // TODO(discord-gateway): await (client as Client | undefined)?.destroy();
    void client;
  }

  return { start, stop };
}
