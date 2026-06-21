import type { Logger } from "./logger.js";
import { getRedis } from "./redis.js";

/**
 * Connector-runtime liveness heartbeat — the connector-neutral generalization of
 * {@link ./discord-gateway-heartbeat.ts}. A long-lived inbound runtime (the
 * leased gateway socket) writes a TTL'd Redis key on an interval; readers (the
 * admin `/connectors` projection Studio reads) treat a fresh key as "this
 * connector's runtime is alive". Because ONLY the lease-holder writes it (see
 * connectors/runtime.ts), a fresh key means "this deployment's elected leader
 * owns the socket" — liveness is OWNED, not merely observed, so a stray process
 * can no longer light the dashboard green.
 *
 * The payload carries an opaque `metadata` blob (e.g. `{ guildId, intents }` for
 * Discord) folded in by the runtime — so the heartbeat stays platform-neutral
 * while still surfacing the bits Studio shows. Everything is best-effort: a
 * missing/unreachable Redis never crashes the runtime and reads back as "down".
 *
 * The legacy Discord key (`hogsend:discord-gateway:heartbeat`, still written by
 * the standalone `discord-worker.ts` hatch via {@link startDiscordGatewayHeartbeat})
 * is honoured as a READ fallback for `connectorId === "discord"`, so a
 * mid-rollout deploy where the old standalone worker is still the writer keeps
 * showing green until the inline runtime takes over.
 */
const TTL_SECONDS = 30;
const REFRESH_MS = 10_000;

const heartbeatKey = (connectorId: string) =>
  `hogsend:connector-runtime:${connectorId}:heartbeat`;

/** The legacy standalone-Discord key — read-only fallback for one minor. */
const LEGACY_DISCORD_KEY = "hogsend:discord-gateway:heartbeat";

export interface ConnectorHeartbeat {
  /** True when a fresh runtime heartbeat is present in Redis. */
  alive: boolean;
  /** ISO timestamp the runtime last wrote, when alive. */
  lastSeenAt?: string;
  /** Opaque platform metadata the runtime folded in (e.g. guildId, intents). */
  metadata?: Record<string, unknown>;
}

/** The JSON shape persisted under {@link heartbeatKey}. */
interface HeartbeatPayload {
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectorHeartbeatState {
  /**
   * Merge a metadata patch (read-merge-write) and flush immediately, so Studio
   * reflects a late-observed field (e.g. the guild id seen at GUILD_CREATE)
   * without waiting for the next refresh tick.
   */
  setMetadata(patch: Record<string, unknown>): void;
}

export interface ConnectorHeartbeatHandle {
  state: ConnectorHeartbeatState;
  /** Clear the timer and delete the key for an immediate "down" on demotion. */
  stop(): Promise<void>;
}

/**
 * Begin writing a connector-runtime heartbeat. Writes once immediately, then
 * refreshes every {@link REFRESH_MS} with a {@link TTL_SECONDS} expiry — so an
 * ungraceful death (or a lost lease) is reflected as "down" within the TTL.
 */
export function startConnectorHeartbeat(
  connectorId: string,
  logger: Logger,
): ConnectorHeartbeatHandle {
  let warned = false;
  let metadata: Record<string, unknown> = {};
  const key = heartbeatKey(connectorId);

  const write = async () => {
    const payload: HeartbeatPayload = {
      lastSeenAt: new Date().toISOString(),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    try {
      await getRedis().set(key, JSON.stringify(payload), "EX", TTL_SECONDS);
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.debug("Connector heartbeat write failed (Redis unreachable?)", {
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  void write();
  const timer = setInterval(() => void write(), REFRESH_MS);
  // Never hold the process open for the heartbeat alone.
  timer.unref?.();

  return {
    state: {
      setMetadata(patch: Record<string, unknown>) {
        metadata = { ...metadata, ...patch };
        void write();
      },
    },
    async stop() {
      clearInterval(timer);
      try {
        await getRedis().del(key);
      } catch {
        // Best-effort — the TTL expires it anyway.
      }
    },
  };
}

/** Normalize a stored payload string into a {@link ConnectorHeartbeat}. */
function parsePayload(raw: string): ConnectorHeartbeat {
  try {
    const parsed = JSON.parse(raw) as HeartbeatPayload;
    return {
      alive: true,
      lastSeenAt: parsed.lastSeenAt,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    };
  } catch {
    // Legacy plain-string value (a bare ISO timestamp) — alive, no metadata.
    return { alive: true, lastSeenAt: raw };
  }
}

/**
 * Normalize the LEGACY Discord heartbeat (`{ lastSeenAt, guildId?, intents? }`)
 * into the connector-neutral shape so the admin projection reads one schema.
 */
function parseLegacyDiscord(raw: string): ConnectorHeartbeat {
  try {
    const parsed = JSON.parse(raw) as {
      lastSeenAt: string;
      guildId?: string;
      intents?: number;
    };
    const metadata: Record<string, unknown> = {};
    if (parsed.guildId) metadata.guildId = parsed.guildId;
    if (typeof parsed.intents === "number") metadata.intents = parsed.intents;
    return {
      alive: true,
      lastSeenAt: parsed.lastSeenAt,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  } catch {
    return { alive: true, lastSeenAt: raw };
  }
}

/**
 * Read a connector-runtime heartbeat. Resolves to `{ alive: false }` when the
 * key is missing or Redis is unreachable. For `connectorId === "discord"`, falls
 * back to the legacy standalone-worker key so a mid-rollout deploy stays green.
 */
export async function getConnectorHeartbeat(
  connectorId: string,
): Promise<ConnectorHeartbeat> {
  try {
    const redis = getRedis();
    const raw = await redis.get(heartbeatKey(connectorId));
    if (raw) return parsePayload(raw);
    if (connectorId === "discord") {
      const legacy = await redis.get(LEGACY_DISCORD_KEY);
      if (legacy) return parseLegacyDiscord(legacy);
    }
    return { alive: false };
  } catch {
    return { alive: false };
  }
}
