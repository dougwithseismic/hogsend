import { DISCORD_INTENTS } from "../constants.js";
import { DiscordEvents } from "../events.js";
import { type PostToIngressResult, postToIngress } from "./ingress.js";

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
  /**
   * Called with the guild id observed at `GUILD_CREATE` — lets the consumer fold
   * it into the gateway heartbeat so Studio can confirm "Bot installed".
   */
  onGuildObserved?: (guildId: string) => void;
  /**
   * In-process dispatch sink. When supplied, each raw dispatch is handed to this
   * poster INSTEAD of the default HTTP ingress POST — so an engine-hosted inline
   * runtime feeds `transform`→`ingest` directly, with no network hop and no
   * shared ingress secret. Omit for the standalone (HTTP) path.
   */
  poster?: IngressPoster;
}

export interface DiscordGatewayWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * The resolved intents bitfield this worker requests at login (the configured
   * value, else the default privileged trio + base). Lets the consumer fold the
   * live intents into the gateway heartbeat for Studio's intents chip.
   */
  getIntents(): number;
}

/**
 * The single dispatch→ingress hop, injected so the mapping can be unit-tested
 * without a live socket (production passes {@link postToIngress}).
 */
type IngressPoster = (args: {
  apiPublicUrl: string;
  ingressSecret: string;
  dispatchType: string;
  data: unknown;
}) => Promise<PostToIngressResult>;

/**
 * Forward one raw Gateway dispatch to the connector ingress. REAL + correct —
 * the live socket loop in `start()` calls exactly this on every `raw` packet.
 * Skips dispatch types the connector does not map (cheap pre-filter) and never
 * throws (a forward failure is logged, not fatal, so the socket stays up).
 *
 * Exported for unit tests: the dispatch→ingress mapping (pre-filter + `{ __t, d }`
 * wrapping + shared-secret forwarding) is exercised by injecting a fake poster,
 * so no live `discord.js` socket is needed.
 */
export async function forwardDispatch(
  config: DiscordGatewayWorkerConfig,
  packet: { t?: string | null; d?: unknown },
  poster: IngressPoster = postToIngress,
): Promise<void> {
  if (!packet.t || !(packet.t in DiscordEvents)) return;
  try {
    const result = await poster({
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
    // Log the message only (not the raw error object) — the worker's sole
    // secret is the bot token; matches the status-only hygiene in connect/oauth.
    console.error(
      "discord ingress forward failed:",
      err instanceof Error ? err.message : String(err),
    );
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

  // Structural holder — keeps zero `discord.js` type coupling at module load
  // (the runtime module is only pulled by the dynamic import inside start()).
  let client: { destroy(): Promise<void> } | undefined;

  async function start(): Promise<void> {
    // `discord.js` is an OPTIONAL peer, dynamically imported here so the engine
    // API process (connector/destination only) never loads a WebSocket client.
    const { Client } = await import("discord.js");
    const c = new Client({ intents });
    client = c;

    // Forward EVERY raw Gateway dispatch — the connector transform owns event
    // selection, so the worker subscribes to nothing typed and stays dumb.
    // `raw` isn't in discord.js's typed `ClientEvents`, but `Client#on` has a
    // string overload that types args as `unknown[]`, so an explicit packet
    // annotation compiles with no cast. discord.js emits the full raw Gateway
    // frame ({ t, s, op, d }) on every Dispatch.
    c.on("raw", (packet: { t?: string | null; d?: unknown }) => {
      // Surface the guild id at GUILD_CREATE so the consumer can fold it into
      // the gateway heartbeat — the strongest "Bot installed" proof for an
      // env-only deploy (no derived credential carrying a guild id).
      if (config.onGuildObserved && packet.t === "GUILD_CREATE") {
        const gid = (packet.d as { id?: string } | undefined)?.id;
        if (gid) config.onGuildObserved(gid);
      }
      // Fire-and-forget: forwardDispatch never throws (it try/catches and logs),
      // so a slow/failed ingress POST never blocks the socket or crashes us.
      // `config.poster` (engine inline runtime) overrides the default HTTP poster;
      // undefined ⇒ the standalone HTTP ingress path.
      void forwardDispatch(config, packet, config.poster);
    });
    // discord.js v14 routes SOCKET errors to `shardError` (and signals lifecycle
    // via `shardDisconnect`/`invalidated`), NOT the generic `error` event. The
    // generic `error` listener stays purely as the EventEmitter safety net — an
    // unhandled 'error' emit takes the process down, so we keep one registered
    // even though it catches almost nothing in normal operation.
    c.on("error", (err: Error) => {
      console.error("discord gateway client error:", err.message);
    });
    // Per-shard transport error — @discordjs/ws auto-reconnects underneath, so
    // log (message only) and let it recover. Without this listener the shard
    // error can escalate to an unhandled EventEmitter 'error' and crash us.
    c.on("shardError", (err: Error, shardId: number) => {
      console.error(`discord gateway shard ${shardId} error:`, err.message);
    });
    // A shard dropped its socket. discord.js attempts RESUME/reconnect, so this
    // is usually recoverable — log the close code (no secrets) and ride it out.
    // closeCode 1000 is a clean close; 4004/4013/4014 (bad token / invalid or
    // disallowed intents) are unrecoverable and surface via `invalidated`.
    c.on("shardDisconnect", (closeEvent: { code: number }, shardId: number) => {
      console.error(
        `discord gateway shard ${shardId} disconnected (close ${closeEvent.code})`,
      );
    });
    // discord.js gave up reconnecting (session invalidated / unrecoverable) —
    // the socket is dead and zero events will flow, yet the process would
    // otherwise sit idle looking healthy. Fail loudly so the orchestrator
    // (Railway) restarts a fresh worker instead of a silent black hole.
    c.on("invalidated", () => {
      console.error(
        "discord gateway session invalidated — exiting so a fresh worker starts",
      );
      process.exit(1);
    });
    c.once("ready", () => {
      console.log("discord gateway worker connected");
    });

    // Rejects on a bad token or disallowed (un-toggled) privileged intents —
    // that rejection propagates out of start(), so a misconfigured worker still
    // fails loudly. discord.js owns heartbeat / RESUME / reconnect / sharding.
    await c.login(config.botToken);
  }

  async function stop(): Promise<void> {
    // Closes the shard(s) and clears timers; await so SIGTERM/SIGINT drains.
    await client?.destroy();
    client = undefined;
  }

  return { start, stop, getIntents: () => intents };
}
