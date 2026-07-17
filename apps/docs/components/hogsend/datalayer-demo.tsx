"use client";

/**
 * Self-contained, interactive demo of the GTM `dataLayer` bridge. Mounts its OWN
 * `<HogsendProvider>` (nested under the docs provider) with a stubbed `fetch`, so
 * it exercises the bridge — pure client-side logic — without sending any real
 * events to an engine. Both directions are visible in one live `dataLayer` view:
 *   • capture() → a `hogsend.<name>` entry appears (outbound mirror).
 *   • a bare `dataLayer.push({event})` on the allowlist → Hogsend ingests it and
 *     its `hogsend.<name>` echo appears (inbound). A non-allowlisted push shows
 *     no echo (the allowlist at work).
 */

import {
  type DataLayerEntry,
  HogsendProvider,
  useHogsend,
} from "@hogsend/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

// Return a fake 202 so no real telemetry leaves the page — the bridge is pure
// client-side logic, so the demo exercises it fully without a network.
const stubFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ stored: true, contactKey: "demo" }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });

type Entry = DataLayerEntry;

// Stable React key per dataLayer entry object (append-only log; no array index).
const entryIds = new WeakMap<object, number>();
let entryIdSeq = 0;
function entryId(entry: object): number {
  let id = entryIds.get(entry);
  if (id === undefined) {
    id = ++entryIdSeq;
    entryIds.set(entry, id);
  }
  return id;
}

function getDataLayer(): Entry[] {
  const w = window as unknown as { dataLayer?: Entry[] };
  return Array.isArray(w.dataLayer) ? w.dataLayer : [];
}

function DemoInner() {
  const { capture } = useHogsend();
  const [entries, setEntries] = useState<Entry[]>([]);

  const sync = useCallback(() => setEntries([...getDataLayer()]), []);

  // Every mutation path calls sync() synchronously (the outbound mirror runs
  // inside capture() before its first await), so a mount refresh is enough.
  useEffect(() => {
    sync();
  }, [sync]);

  const act = (fn: () => void) => () => {
    fn();
    sync();
  };

  const pushRaw = (entry: Entry) => {
    (window as unknown as { dataLayer: Entry[] }).dataLayer.push(entry);
  };

  const reset = () => {
    getDataLayer().length = 0; // truncate in place — keep the bridge's reference
    sync();
  };

  const captured = entries.filter(
    (e) => typeof e.event === "string" && e.event.startsWith("hogsend."),
  ).length;

  return (
    <div className="not-prose my-8 grid gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-5 md:grid-cols-2">
      {/* ── actions ── */}
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-semibold text-white">
            Outbound — Hogsend → GTM
          </p>
          <p className="mt-1 text-xs text-white/50">
            An SDK <code>capture()</code> mirrors onto the dataLayer as{" "}
            <code>hogsend.&lt;name&gt;</code>.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <DemoButton onClick={act(() => capture("checkout"))}>
              capture("checkout")
            </DemoButton>
            <DemoButton
              onClick={act(() =>
                capture("purchase", { plan: "pro", value: 49 }),
              )}
            >
              capture("purchase", …)
            </DemoButton>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-white">
            Inbound — GTM → Hogsend
          </p>
          <p className="mt-1 text-xs text-white/50">
            A bare <code>dataLayer.push()</code>. Allowlisted events are
            ingested (watch: <code>sign_up</code>, <code>purchase</code>) —
            you'll see a <code>hogsend.*</code> echo. Others are ignored.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <DemoButton
              onClick={act(() =>
                pushRaw({
                  event: "sign_up",
                  plan: "pro",
                  ecommerce: { items: 1 },
                }),
              )}
            >
              push sign_up ✓
            </DemoButton>
            <DemoButton onClick={act(() => pushRaw({ event: "page_view" }))}>
              push page_view ✗
            </DemoButton>
          </div>
        </div>

        <button
          type="button"
          onClick={reset}
          className="mt-auto self-start text-xs text-white/40 underline-offset-4 hover:text-white/70 hover:underline"
        >
          Reset
        </button>
      </div>

      {/* ── live dataLayer ── */}
      <div className="flex min-h-[18rem] flex-col rounded-lg border border-white/10 bg-black/40">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="font-mono text-xs text-white/60">
            window.dataLayer
          </span>
          <span className="text-xs text-white/40">
            {entries.length} entries · {captured} captured
          </span>
        </div>
        <div className="flex-1 space-y-1.5 overflow-auto p-3 font-mono text-xs">
          {entries.length === 0 ? (
            <p className="text-white/30">
              Empty — click an action to populate the dataLayer.
            </p>
          ) : (
            [...entries].reverse().map((e) => {
              const name = typeof e.event === "string" ? e.event : "(no event)";
              const isHs = name.startsWith("hogsend.");
              const rest = Object.fromEntries(
                Object.entries(e).filter(([k]) => k !== "event"),
              );
              return (
                <div
                  key={entryId(e)}
                  className={`rounded px-2 py-1 ${
                    isHs
                      ? "border border-accent/30 bg-accent-tint text-white"
                      : "bg-white/[0.03] text-white/70"
                  }`}
                >
                  <span className={isHs ? "text-accent" : "text-white/90"}>
                    {name}
                  </span>
                  {Object.keys(rest).length > 0 && (
                    <span className="text-white/40">
                      {" "}
                      {JSON.stringify(rest)}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function DemoButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 font-mono text-xs text-white transition-colors hover:border-accent/50 hover:bg-accent-tint"
    >
      {children}
    </button>
  );
}

export function DataLayerDemo() {
  return (
    <HogsendProvider
      apiUrl="https://demo.local"
      publishableKey="pk_demo"
      fetch={stubFetch}
      colorMode="dark"
      dataLayer={{ push: true, watch: { events: ["sign_up", "purchase"] } }}
    >
      <DemoInner />
    </HogsendProvider>
  );
}
