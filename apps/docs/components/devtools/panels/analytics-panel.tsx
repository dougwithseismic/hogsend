"use client";

import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";
import { AnalyticsEvent, hasConsented } from "@/lib/analytics";
import { Button, Empty, PanelShell, Pill, Row, Section } from "./panel-ui";

/**
 * AnalyticsDevtoolsPanel — a PRODUCT-specific devtools panel.
 *
 * It inspects this app's real analytics runtime (the PostHog instance booted by
 * `components/analytics/posthog-boot.tsx`): a live tail of every captured event,
 * the event catalog, and the boot/identity/consent status. Because it reads the
 * running `posthog-js` singleton directly, it needs no wiring from product code
 * — dropping the panel into the shell's `plugins` array is the whole
 * integration. That is the point of the unified shell: product observability
 * without coupling the app to one inspector.
 *
 * The tail groups events into collapsible categories so PostHog's own
 * high-frequency internal events (`$pageview`, `$autocapture`, `$snapshot`,
 * `$$heatmap`…) don't drown out the product events you actually care about.
 */

type Status = {
  loaded: boolean;
  distinctId: string;
  sessionId: string;
  consented: boolean;
  optedIn: boolean;
};

/** Tail categories, rendered as collapsible groups (top → bottom). */
type Category = "hogsend" | "posthog";

const CATEGORIES: Array<{
  id: Category;
  label: string;
  hint: string;
  color: string;
}> = [
  {
    id: "hogsend",
    label: "Hogsend",
    hint: "your product events",
    color: "#a5b4fc",
  },
  {
    id: "posthog",
    label: "PostHog",
    hint: "autocapture · sessions · pageviews",
    color: "#fca5a5",
  },
];

/**
 * PostHog's own events are `$`-prefixed (`$pageview`, `$autocapture`,
 * `$snapshot`, `$$heatmap`, `$web_vitals`…); everything else is a product /
 * Hogsend event (`docs.*`, `referral.*`, …).
 */
function categorize(name: string): Category {
  return name.startsWith("$") ? "posthog" : "hogsend";
}

type CapturedEvent = {
  key: number;
  name: string;
  cat: Category;
  time: string;
  props: Record<string, unknown>;
};

/**
 * Keep newest-N PER CATEGORY. A burst of PostHog `$snapshot` noise can then
 * never evict the rarer product events from the buffer — each group holds its
 * own tail.
 */
const CAP: Record<Category, number> = { hogsend: 40, posthog: 30 };

function readStatus(): Status {
  // Every call is best-effort: pre-boot the posthog stub can throw or return
  // undefined, so we never let the panel take the app down with it.
  const safe = <T,>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    loaded: safe(() => Boolean(posthog.__loaded), false),
    distinctId: safe(() => posthog.get_distinct_id() ?? "—", "—"),
    sessionId: safe(() => posthog.get_session_id?.() ?? "—", "—"),
    consented: safe(() => hasConsented(), false),
    optedIn: safe(() => posthog.has_opted_in_capturing?.() ?? false, false),
  };
}

/** One expandable event row: name + time, click to reveal its properties. */
function EventRow({
  event,
  open,
  color,
  onToggle,
}: {
  event: CapturedEvent;
  open: boolean;
  color: string;
  onToggle: () => void;
}) {
  const keys = Object.keys(event.props);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          gap: 8,
          alignItems: "baseline",
          justifyContent: "space-between",
          background: "transparent",
          border: "none",
          cursor: keys.length ? "pointer" : "default",
          padding: "3px 0",
          textAlign: "left",
          color: "inherit",
        }}
      >
        <span
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color }}
        >
          {keys.length ? (open ? "▾ " : "▸ ") : "· "}
          {event.name}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.35)",
            flexShrink: 0,
          }}
        >
          {event.time}
        </span>
      </button>
      {open && keys.length > 0 ? (
        <pre
          style={{
            margin: "2px 0 6px 12px",
            padding: 8,
            borderRadius: 6,
            background: "rgba(255,255,255,0.04)",
            fontSize: 11,
            lineHeight: 1.5,
            overflow: "auto",
            color: "rgba(255,255,255,0.8)",
          }}
        >
          {JSON.stringify(event.props, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function AnalyticsDevtoolsPanel() {
  const [status, setStatus] = useState<Status>(readStatus);
  const [events, setEvents] = useState<Array<CapturedEvent>>([]);
  // Product group open by default; the noisy PostHog group collapsed.
  const [openCats, setOpenCats] = useState<Record<Category, boolean>>({
    hogsend: true,
    posthog: false,
  });
  const [expanded, setExpanded] = useState<number | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    // `posthog.on("eventCaptured")` only exists after init, and this panel can
    // mount before the async config fetch resolves. So we poll: retry the
    // subscribe until it takes, and refresh the status readout on the same tick.
    const subscribe = () => {
      if (unsubscribe || !posthog.__loaded) return;
      try {
        unsubscribe = posthog.on("eventCaptured", (payload: unknown) => {
          const p = payload as
            | { event?: string; properties?: Record<string, unknown> }
            | undefined;
          const name = p?.event ?? "(unknown)";
          const entry: CapturedEvent = {
            key: counter.current++,
            name,
            cat: categorize(name),
            time: new Date().toLocaleTimeString(),
            props: p?.properties ?? {},
          };
          setEvents((prev) => {
            const seen: Record<Category, number> = { hogsend: 0, posthog: 0 };
            // Newest-first; keep only the newest CAP[cat] of each category.
            return [entry, ...prev].filter((e) => {
              seen[e.cat] += 1;
              return seen[e.cat] <= CAP[e.cat];
            });
          });
        });
      } catch {
        // Not ready yet — the interval below will try again.
      }
    };

    subscribe();
    const timer = setInterval(() => {
      subscribe();
      setStatus(readStatus());
    }, 1000);

    return () => {
      clearInterval(timer);
      unsubscribe?.();
    };
  }, []);

  return (
    <PanelShell>
      <Section
        title="Live event tail"
        action={
          <span
            style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
          >
            <span
              style={{
                fontFamily: "ui-monospace, monospace",
                color: "rgba(255,255,255,0.4)",
              }}
            >
              {events.length}
            </span>
            <Button onClick={() => setEvents([])}>clear</Button>
          </span>
        }
      >
        {events.length === 0 ? (
          <Empty>
            Waiting for captures. This tails events live from the moment the
            panel opened — interact with the page and they'll stream in.
          </Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {CATEGORIES.map((c) => {
              const rows = events.filter((e) => e.cat === c.id);
              const open = openCats[c.id];
              return (
                <div key={c.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenCats((s) => ({ ...s, [c.id]: !s[c.id] }))
                    }
                    style={{
                      display: "flex",
                      width: "100%",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid rgba(255,255,255,0.06)",
                      padding: "4px 0",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                        fontWeight: 600,
                        color: c.color,
                      }}
                    >
                      {open ? "▾ " : "▸ "}
                      {c.label}
                      <span
                        style={{
                          marginLeft: 8,
                          fontWeight: 400,
                          color: "rgba(255,255,255,0.35)",
                        }}
                      >
                        {c.hint}
                      </span>
                    </span>
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 11,
                        padding: "1px 7px",
                        borderRadius: 999,
                        background: `${c.color}22`,
                        color: c.color,
                        flexShrink: 0,
                      }}
                    >
                      {rows.length}
                    </span>
                  </button>
                  {open ? (
                    rows.length === 0 ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(255,255,255,0.35)",
                          fontStyle: "italic",
                          padding: "5px 0 5px 14px",
                        }}
                      >
                        none yet
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                          paddingLeft: 14,
                        }}
                      >
                        {rows.map((e) => (
                          <EventRow
                            key={e.key}
                            event={e}
                            color={c.color}
                            open={expanded === e.key}
                            onToggle={() =>
                              setExpanded(expanded === e.key ? null : e.key)
                            }
                          />
                        ))}
                      </div>
                    )
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Event catalog"
        action={
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              color: "rgba(255,255,255,0.4)",
            }}
          >
            {Object.keys(AnalyticsEvent).length}
          </span>
        }
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {Object.entries(AnalyticsEvent).map(([token, name]) => (
            <code
              key={token}
              title={token}
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 5,
                background: "rgba(165,180,252,0.1)",
                color: "#c7d2fe",
              }}
            >
              {name}
            </code>
          ))}
        </div>
      </Section>

      <Section title="PostHog runtime">
        <Row
          label="status"
          value={
            <Pill ok={status.loaded}>
              {status.loaded ? "loaded" : "not booted"}
            </Pill>
          }
        />
        <Row label="distinct_id" value={status.distinctId} mono />
        <Row label="session_id" value={status.sessionId} mono />
        <Row
          label="consent"
          value={
            <Pill ok={status.consented}>
              {status.consented ? "granted" : "pending"}
            </Pill>
          }
        />
        <Row
          label="persistence"
          value={
            status.consented ? "localStorage+cookie" : "memory (cookieless)"
          }
          mono
        />
        <Row label="opted_in_capturing" value={String(status.optedIn)} mono />
      </Section>
    </PanelShell>
  );
}
