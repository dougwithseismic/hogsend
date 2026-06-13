import type { Logger } from "./logger.js";
import { getRedis } from "./redis.js";

/**
 * Discord Gateway worker liveness heartbeat. The gateway worker is its OWN
 * long-lived process (a `discord.js` socket forwarding raw dispatches), separate
 * from BOTH the API and the Hatchet worker — so the API (and Studio's
 * `/integrations` card) cannot otherwise tell whether the gateway socket is
 * actually up. The worker writes a TTL'd key to Redis on an interval; readers
 * treat a fresh key as "the gateway worker is alive".
 *
 * This mirrors {@link ./worker-heartbeat.ts} but on a DISTINCT key and with a
 * richer JSON payload: it also carries the guild id the live worker observed at
 * `GUILD_CREATE`, which lets the card confirm "Bot installed" for env-only
 * deploys (no derived credential) — a fresh heartbeat with a guild id IS the
 * proof-of-configuration the status fix needs.
 *
 * Redis is the channel because both processes can already reach it and the
 * health route already probes it — no direct process-to-process coupling, no
 * migration. Everything here is best-effort: a missing/unreachable Redis never
 * crashes the worker and simply reads back as "down".
 */
const HEARTBEAT_KEY = "hogsend:discord-gateway:heartbeat";
const TTL_SECONDS = 30;
const REFRESH_MS = 10_000;

export interface DiscordGatewayHeartbeat {
  /** True when a fresh gateway-worker heartbeat is present in Redis. */
  alive: boolean;
  /** ISO timestamp the gateway worker last wrote, when alive. */
  lastSeenAt?: string;
  /** The guild id the live worker observed (confirms the bot is in a server). */
  guildId?: string;
}

/** The JSON shape persisted under {@link HEARTBEAT_KEY}. */
interface HeartbeatPayload {
  lastSeenAt: string;
  guildId?: string;
}

/** The mutable state a running heartbeat exposes for late-bound guild folding. */
export interface DiscordGatewayHeartbeatState {
  /**
   * Fold the worker-observed guild id into the heartbeat and write immediately,
   * so Studio can confirm "Bot installed" as soon as the socket sees a guild.
   */
  setGuildId(guildId: string): void;
}

export interface DiscordGatewayHeartbeatHandle {
  /** Mutable state — call `setGuildId` from the worker's `onGuildObserved` tap. */
  state: DiscordGatewayHeartbeatState;
  /** Clear the timer and delete the key for an immediate "down" on shutdown. */
  stop(): Promise<void>;
}

/**
 * Begin writing the Discord gateway-worker heartbeat. Writes once immediately,
 * then refreshes every {@link REFRESH_MS} with a {@link TTL_SECONDS} expiry — so
 * an ungraceful worker death is reflected as "down" within the TTL. The returned
 * handle exposes `state.setGuildId(id)` (fold in the observed guild + write now)
 * and `stop()` (clear the timer + delete the key for an immediate "down").
 */
export function startDiscordGatewayHeartbeat(
  logger: Logger,
): DiscordGatewayHeartbeatHandle {
  let warned = false;
  let guildId: string | undefined;

  const write = async () => {
    const payload: HeartbeatPayload = {
      lastSeenAt: new Date().toISOString(),
      ...(guildId ? { guildId } : {}),
    };
    try {
      await getRedis().set(
        HEARTBEAT_KEY,
        JSON.stringify(payload),
        "EX",
        TTL_SECONDS,
      );
    } catch (err) {
      // Log the first failure only — a Redis-less deploy would otherwise spam.
      if (!warned) {
        warned = true;
        logger.debug(
          "Discord gateway heartbeat write failed (Redis unreachable?)",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  };

  void write();
  const timer = setInterval(() => void write(), REFRESH_MS);
  // Never hold the process open for the heartbeat alone.
  timer.unref?.();

  return {
    state: {
      setGuildId(id: string) {
        guildId = id;
        // Write immediately so the card flips to "Bot installed" without waiting
        // for the next refresh tick.
        void write();
      },
    },
    async stop() {
      clearInterval(timer);
      try {
        await getRedis().del(HEARTBEAT_KEY);
      } catch {
        // Best-effort — the TTL expires it anyway.
      }
    },
  };
}

/**
 * Read the current Discord gateway-worker heartbeat. Resolves to
 * `{ alive: false }` if the key is missing or Redis is unreachable. Tolerates a
 * legacy plain-string value (treated as alive with no guild) so a reader can
 * outlive a payload-shape change.
 */
export async function getDiscordGatewayHeartbeat(): Promise<DiscordGatewayHeartbeat> {
  try {
    const raw = await getRedis().get(HEARTBEAT_KEY);
    if (!raw) return { alive: false };
    try {
      const parsed = JSON.parse(raw) as HeartbeatPayload;
      return {
        alive: true,
        lastSeenAt: parsed.lastSeenAt,
        ...(parsed.guildId ? { guildId: parsed.guildId } : {}),
      };
    } catch {
      // Legacy plain-string value (a bare ISO timestamp) — alive, no guild.
      return { alive: true, lastSeenAt: raw };
    }
  } catch {
    return { alive: false };
  }
}
