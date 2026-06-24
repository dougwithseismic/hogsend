import type { HogsendClient } from "../container.js";
import {
  type ConnectorHeartbeatHandle,
  startConnectorHeartbeat,
} from "../lib/connector-heartbeat.js";
import { ingestTransformResult } from "../lib/ingestion.js";
import {
  acquireLeaderLease,
  newLeaseToken,
  releaseLeaderLease,
  renewLeaderLease,
} from "../lib/leader-lease.js";
import type { Logger } from "../lib/logger.js";
import type { DefinedConnector } from "./define-connector.js";

/**
 * The connector-agnostic INBOUND RUNTIME seam. A `gateway`-transport connector
 * (Discord today, Slack tomorrow) needs a long-lived process holding a socket to
 * the platform. Rather than a hand-wired standalone service per consumer, the
 * engine boots that runtime INLINE inside the process every consumer already
 * runs (the Hatchet worker by default), gated by a Redis LEADER LEASE so exactly
 * ONE replica ever holds the socket — one bot token permits one live session.
 *
 * A platform plugin contributes a {@link ConnectorRuntimeFactory} (supplied to
 * `createWorker({ connectorRuntimes })`); the engine owns everything
 * platform-neutral: lease election, the in-process dispatch→transform→ingest
 * sink (no HTTP hop, no shared secret), the owned heartbeat, and shutdown
 * ordering. A second connector reuses this verbatim — it only writes a
 * `defineConnector` + a runtime factory, and touches zero engine code.
 */

/** The minimal long-lived runtime a platform plugin supplies (e.g. a discord.js socket). */
export interface ConnectorRuntime {
  /** Open the socket. Rejects loudly on a fatal config error (bad token/intents). */
  start(): Promise<void>;
  /** Close the socket and clear timers (awaited on demotion / shutdown). */
  stop(): Promise<void>;
  /** Platform metadata to fold into the heartbeat (e.g. `{ intents }`). */
  getMetadata(): Record<string, unknown>;
}

/**
 * What the engine injects into a runtime factory. `ingest` is the in-process
 * sink: hand it a raw platform dispatch and the engine runs the connector's own
 * `transform` then `ingestEvent` — the EXACT pair the HTTP ingress route runs,
 * minus the network hop. `onMetadata` folds a late-observed field (e.g. the
 * guild id seen at GUILD_CREATE) into the live heartbeat.
 */
export interface ConnectorRuntimeDeps {
  ingest(
    dispatchType: string,
    data: unknown,
  ): Promise<{ ok: boolean; status: number }>;
  onMetadata(patch: Record<string, unknown>): void;
  logger: Logger;
}

/**
 * Build a runtime for a connector, or return `null` when it is not configured to
 * run here (e.g. the platform's bot token env is unset) — the engine then simply
 * skips it without holding a lease.
 */
export type ConnectorRuntimeFactory = (
  deps: ConnectorRuntimeDeps,
) => ConnectorRuntime | null;

export interface ConnectorRuntimesHandle {
  /** Release every lease + delete heartbeats BEFORE stopping sockets. */
  stop(): Promise<void>;
}

const LEASE_TTL_MS = 30_000;
const RENEW_MS = 10_000;
const ELECT_MS = 5_000;
// ~30s of failed elections (6 * ELECT_MS) before warning loudly that a
// configured runtime still can't acquire its lease (Redis down or contended).
const LEASE_MISS_WARN_AT = 6;

/** Build the in-process dispatch→transform→ingest sink for one connector. */
function makeIngest(client: HogsendClient, connector: DefinedConnector) {
  return async (
    dispatchType: string,
    data: unknown,
  ): Promise<{ ok: boolean; status: number }> => {
    try {
      // Reconstruct the EXACT envelope the HTTP ingress route receives
      // (`{ __t, d }`) so the connector transform is byte-identical whether the
      // dispatch arrived over HTTP or in-process.
      const payload = { __t: dispatchType, d: data };
      const result = await connector.transform(payload, {
        db: client.db,
        logger: client.logger,
        transport: "gateway",
      });
      // A transform may return a single event, an ARRAY (dual-side fan-out), or
      // null — ingestTransformResult normalizes + per-element-isolates. Pass the
      // active analytics provider so a Discord-keyed contact merge stitches the
      // analytics person too (the HTTP route omits this; in-proc holds the
      // container).
      await ingestTransformResult({
        result,
        db: client.db,
        registry: client.registry,
        hatchet: client.hatchet,
        logger: client.logger,
        source: "connector",
        analytics: client.analytics,
      });
      return { ok: true, status: 200 };
    } catch (err) {
      client.logger.warn("Connector runtime in-process ingest failed", {
        connectorId: connector.meta.id,
        dispatchType,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, status: 500 };
    }
  };
}

/**
 * Per-connector lease controller: a single timer loop that races for the lease,
 * starts the runtime + heartbeat on a win, renews while it leads, and demotes
 * (stop socket + heartbeat) the moment a renew is lost — then re-enters the
 * race, giving bounded automatic failover within the TTL with no two-holder
 * overlap.
 */
function startController(
  client: HogsendClient,
  connector: DefinedConnector,
  factory: ConnectorRuntimeFactory,
): ConnectorRuntimesHandle | null {
  const { logger } = client;
  const connectorId = connector.meta.id;
  const leaseKey = `hogsend:connector-runtime:${connectorId}:leader`;

  let heartbeat: ConnectorHeartbeatHandle | undefined;

  const runtime = factory({
    ingest: makeIngest(client, connector),
    onMetadata: (patch) => heartbeat?.state.setMetadata(patch),
    logger,
  });
  // `null` ⇒ not configured to run here (e.g. no bot token). Skip cleanly — no
  // lease held, no heartbeat written, dashboard stays Offline (truthfully).
  if (!runtime) {
    logger.debug("Connector runtime not configured; skipping", { connectorId });
    return null;
  }
  // Non-null alias the hoisted closures below capture (a const keeps TS's
  // post-guard narrowing; the bare `runtime` widens back to `| null` inside
  // them).
  const rt = runtime;

  let leading = false;
  let token = "";
  let stopped = false;
  let leaseMisses = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Drop leadership: heartbeat key deleted FIRST (immediate Offline), then socket. */
  async function demote(): Promise<void> {
    leading = false;
    await heartbeat?.stop();
    heartbeat = undefined;
    try {
      await rt.stop();
    } catch (err) {
      logger.warn("Connector runtime stop failed during demotion", {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      if (!leading) {
        token = newLeaseToken();
        const won = await acquireLeaderLease({
          key: leaseKey,
          token,
          ttlMs: LEASE_TTL_MS,
        });
        if (won) {
          leaseMisses = 0;
          leading = true;
          heartbeat = startConnectorHeartbeat(connectorId, logger);
          heartbeat.state.setMetadata(rt.getMetadata());
          logger.info("Connector runtime acquired lease; opening socket", {
            connectorId,
          });
          try {
            await rt.start();
          } catch (err) {
            // A fatal start (bad token / disallowed intents) — release the lease
            // so another replica (or a fixed redeploy) can try, and surface it.
            logger.error("Connector runtime failed to start; releasing lease", {
              connectorId,
              error: err instanceof Error ? err.message : String(err),
            });
            await heartbeat.stop();
            heartbeat = undefined;
            leading = false;
            await releaseLeaderLease({ key: leaseKey, token });
          }
        } else {
          // Lease not acquired: another replica holds it (benign, normal during
          // rollout) OR Redis is unreachable (the gateway can NEVER connect) —
          // indistinguishable from the boolean. Warn LOUDLY once after ~30s of
          // misses so a genuinely stuck runtime surfaces instead of silently
          // never connecting (which Studio otherwise mis-reads as "intents off").
          leaseMisses++;
          if (leaseMisses === LEASE_MISS_WARN_AT) {
            logger.error(
              "Connector runtime has not acquired its leader lease after ~30s — " +
                "Redis unreachable (check REDIS_URL points at the SAME instance " +
                "as the API) or another replica holds it; if none does, the " +
                "gateway will not connect.",
              { connectorId },
            );
          }
        }
      } else {
        const renewed = await renewLeaderLease({
          key: leaseKey,
          token,
          ttlMs: LEASE_TTL_MS,
        });
        if (!renewed) {
          logger.warn("Connector runtime lost lease; demoting", {
            connectorId,
          });
          await demote();
        }
      }
    } catch (err) {
      logger.warn("Connector runtime election tick failed", {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), leading ? RENEW_MS : ELECT_MS);
        timer.unref?.();
      }
    }
  }

  void tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (leading) {
        await demote();
        await releaseLeaderLease({ key: leaseKey, token });
      }
    },
  };
}

export interface StartConnectorRuntimesArgs {
  client: HogsendClient;
  /** Platform runtime factories keyed by connector id (from createWorker opts). */
  factories: Record<string, ConnectorRuntimeFactory>;
}

/**
 * Boot the inline runtimes for every registered `gateway`-transport connector
 * that has a supplied factory. Fire-and-forget per connector (each runs its own
 * lease loop); returns a handle whose `stop()` releases all leases + deletes
 * heartbeats before stopping sockets (graceful, heartbeat-first ordering).
 *
 * No-ops cleanly when there are no gateway connectors, no factories, or a
 * factory declines (returns null) — so a deploy with nothing configured carries
 * zero cost.
 */
export function startConnectorRuntimes(
  args: StartConnectorRuntimesArgs,
): ConnectorRuntimesHandle {
  const { client, factories } = args;
  const gateways = client.connectorRegistry.getByTransport("gateway");
  const controllers: ConnectorRuntimesHandle[] = [];

  for (const connector of gateways) {
    const factory = factories[connector.meta.id];
    if (!factory) {
      client.logger.debug(
        "Gateway connector has no runtime factory; skipping",
        {
          connectorId: connector.meta.id,
        },
      );
      continue;
    }
    const controller = startController(client, connector, factory);
    if (controller) controllers.push(controller);
  }

  if (controllers.length > 0) {
    client.logger.info("Connector runtimes started", {
      count: controllers.length,
    });
  }

  return {
    async stop() {
      await Promise.allSettled(controllers.map((c) => c.stop()));
    },
  };
}
