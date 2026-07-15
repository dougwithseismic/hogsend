import { useEffect, useRef, useState } from "react";
import { config } from "@/lib/config";

/**
 * Subscribe to the engine's LIVE flow-transition stream (P4) —
 * `GET /v1/admin/flow/stream`, an SSE feed over Redis pub/sub. Every classified
 * ingest arrives here within ~1s; `flow-view` maps it to an edge and spawns a
 * one-shot pulse.
 *
 * Resilience is the whole job of this hook:
 * - A staleness watchdog closes+reconnects if no ping/transition lands for 45s
 *   (a silently-dead socket that never fires `onerror`).
 * - `onerror` drives exponential backoff (1s→30s, jittered); after 5 straight
 *   failures we surface `unavailable` and STOP — the caller falls back to
 *   polling until `enabled` toggles.
 * - The stream closes on `document.hidden` and reopens on visible, so a
 *   backgrounded tab holds no idle connection.
 *
 * `onTransition` is stored in a ref so a new callback identity never tears down
 * and rebuilds the EventSource.
 */

export type StreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "unavailable";

/** The wire shape the engine publishes (mirror of engine `FlowTransitionMessage`). */
export interface FlowTransitionMessage {
  v: 1;
  contactId: string;
  userId: string;
  from: string | null;
  to: string;
  lane: string | null;
  event: string;
  /** Monetary value of the event (2dp), or null — money renders gold. */
  value: number | null;
  currency: string | null;
  ts: string;
}

/** No ping/transition within this long ⇒ treat the socket as dead. */
const STALE_MS = 45_000;
/** Backoff ceiling for reconnect attempts. */
const BACKOFF_CAP_MS = 30_000;
/** Consecutive failures before we give up and report `unavailable`. */
const MAX_FAILURES = 5;

export interface UseFlowStreamOptions {
  enabled: boolean;
  onTransition: (t: FlowTransitionMessage) => void;
}

export function useFlowStream(opts: UseFlowStreamOptions): {
  status: StreamStatus;
} {
  const { enabled, onTransition } = opts;
  const [status, setStatus] = useState<StreamStatus>("idle");

  // Keep the latest callback without re-running the connection effect.
  const onTransitionRef = useRef(onTransition);
  onTransitionRef.current = onTransition;

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let source: EventSource | null = null;
    let failures = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let givenUp = false;

    const clearTimers = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearTimeout(staleTimer);
      reconnectTimer = undefined;
      staleTimer = undefined;
    };

    const close = () => {
      clearTimers();
      if (source) {
        source.close();
        source = null;
      }
    };

    // (re)arm the staleness watchdog — any inbound frame calls this.
    const bumpWatchdog = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        // Dead-but-open socket: force a reconnect through the same backoff path.
        if (disposed || givenUp) return;
        close();
        scheduleReconnect();
      }, STALE_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || givenUp) return;
      failures += 1;
      if (failures >= MAX_FAILURES) {
        givenUp = true;
        setStatus("unavailable");
        close();
        return;
      }
      setStatus("reconnecting");
      const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (failures - 1));
      const delay = base / 2 + Math.random() * (base / 2);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed || givenUp) return;
      // A backgrounded tab holds no connection; the visibility handler reopens.
      if (typeof document !== "undefined" && document.hidden) {
        setStatus("reconnecting");
        return;
      }
      setStatus((s) => (s === "reconnecting" ? s : "connecting"));

      const es = new EventSource(`${config.baseUrl}/v1/admin/flow/stream`, {
        withCredentials: true,
      });
      source = es;
      // Arm the watchdog from the moment the connection is ATTEMPTED — a
      // stream that opens but never delivers `ready` (buffering proxy, server
      // wedged between accept and subscribe, Redis down so the browser
      // native-retries in CONNECTING forever) would otherwise never trip the
      // failure counter and sit in "connecting" for good.
      bumpWatchdog();

      es.addEventListener("ready", () => {
        failures = 0;
        setStatus("open");
        bumpWatchdog();
      });
      es.addEventListener("ping", () => {
        bumpWatchdog();
      });
      es.addEventListener("transition", (ev) => {
        bumpWatchdog();
        try {
          const parsed = JSON.parse(
            (ev as MessageEvent).data,
          ) as FlowTransitionMessage;
          onTransitionRef.current(parsed);
        } catch {
          // Malformed frame — ignore; the next one likely parses.
        }
      });
      es.onerror = () => {
        // EventSource auto-reconnects while CONNECTING; only act on a hard
        // close so we own the backoff (and can cap/give-up).
        if (es.readyState === EventSource.CLOSED) {
          close();
          scheduleReconnect();
        }
      };
    };

    const onVisibility = () => {
      if (disposed || givenUp) return;
      if (document.hidden) {
        close();
        setStatus("reconnecting");
      } else if (!source) {
        // Reopen fresh on return — reset backoff so a long background doesn't
        // land us mid-ramp.
        failures = 0;
        connect();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    connect();

    return () => {
      disposed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      close();
    };
  }, [enabled]);

  return { status };
}
