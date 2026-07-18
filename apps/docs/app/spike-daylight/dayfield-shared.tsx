"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import {
  type FieldConfig,
  formatClock,
  formatHour,
  hourInZone,
} from "./field-config";

export type { FieldConfig } from "./field-config";

/* ==========================================================================
 *  Field engine — a config-driven "hour window" hero.
 *
 *  One hand-painted scene, relit (and re-populated) for each hour of the day;
 *  the visitor's real LOCAL hour picks the frame. A hidden day-arc scrubber
 *  previews any other hour. Swap a `FieldConfig` (frames + hour→slot mapping)
 *  to ship a new scene — a summer vista, a match day, a holiday — with no new
 *  engine code.
 *
 *  Loading is lazy on purpose: at rest ONLY the current hour's image is in the
 *  DOM (one request). The full set is fetched only when the visitor opens the
 *  preview scrubber. Frames live at /images/<imageDir>/<slot>.webp.
 * ========================================================================== */

const frameSrc = (config: FieldConfig, slot: string) =>
  `/images/${config.imageDir}/${slot}.webp`;

/* ------------------------------------------------------------ the engine -- */

export function useField(config: FieldConfig, initialHour?: number) {
  // Hydration-safe: start null (server + first client paint agree), fill after
  // mount. For a fixed-time field the server passes `initialHour`, so the right
  // frame paints from the first byte with no flash.
  const [now, setNow] = useState<Date | null>(null);
  const [previewHour, setPreviewHour] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const [loaded, setLoaded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, []);

  // Preview only: fetch every frame so scrubbing is instant. At rest we never
  // touch the network beyond the single current-hour image the DOM renders.
  useEffect(() => {
    if (!preview) return;
    for (const s of config.slots) {
      const img = new Image();
      img.onload = () => setLoaded((prev) => new Set(prev).add(s));
      img.src = frameSrc(config, s);
    }
  }, [preview, config]);

  const live = now ? hourInZone(now, config.timeZone) : null;
  const isLive = previewHour === null;
  // The driving hour: previewed hour, else the resolved clock, else the SSR
  // initialHour. `ready` is false only for a local-time field before its client
  // clock resolves — then we paint nothing (dark ground) and fade the real
  // frame in, rather than flashing a wrong guess.
  const ready = !isLive || live !== null || initialHour !== undefined;
  const liveHour = live?.hour ?? initialHour ?? 0;
  const liveMinute = live?.minute ?? 0;
  const hour = isLive ? liveHour : previewHour;
  const state = config.hours(hour);
  // In preview we may cross to a not-yet-decoded frame → hold the last decoded.
  const shownSlot =
    !preview || loaded.has(state.slot)
      ? state.slot
      : (config.slots.find((s) => loaded.has(s)) ?? state.slot);
  const arcPct = ((hour + (isLive ? liveMinute / 60 : 0)) / 24) * 100;

  return {
    now,
    hour,
    isLive,
    ready,
    state,
    shownSlot,
    arcPct,
    preview,
    daylight: config.isDaylight(hour),
    enterPreview: useCallback(() => setPreview(true), []),
    exitPreview: useCallback(() => {
      setPreview(false);
      setPreviewHour(null);
    }, []),
    setPreviewHour,
    clearPreview: useCallback(() => setPreviewHour(null), []),
  };
}

/* --------------------------------------------------------------- parts --- */

export function FieldStyles() {
  return <style>{keyframes}</style>;
}

/** The painting.
 *  - At rest: exactly the current hour's frame (one image), gently faded in
 *    over the dark ground — no wrong-guess flash, no second image.
 *  - In preview: the full stack, crossfaded, so the fetched frames blend as
 *    you scrub. */
function FieldFrames({
  config,
  shownSlot,
  preview,
  ready,
}: {
  config: FieldConfig;
  shownSlot: string;
  preview: boolean;
  ready: boolean;
}) {
  if (preview) {
    return (
      <div className="absolute inset-0">
        {config.slots.map((s) => (
          <div
            key={s}
            aria-hidden="true"
            className="dayfield-frame absolute inset-0 bg-center bg-cover"
            style={{
              backgroundImage: `url(${frameSrc(config, s)})`,
              opacity: shownSlot === s ? 1 : 0,
            }}
          />
        ))}
      </div>
    );
  }
  // Until the clock resolves (local-time field) we render nothing; the dark
  // hero ground shows and the real frame fades in the moment it's known.
  if (!ready) return <div className="absolute inset-0" />;
  return (
    <div className="absolute inset-0">
      <div
        key={shownSlot}
        aria-hidden="true"
        className="dayfield-frame dayfield-in absolute inset-0 bg-center bg-cover"
        style={{ backgroundImage: `url(${frameSrc(config, shownSlot)})` }}
      />
    </div>
  );
}

function ClockChip({
  label,
  time,
  daylight,
  live,
}: {
  label: string;
  time: string;
  daylight: boolean;
  live: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-full border border-white/15 bg-black/30 py-1.5 pr-2 pl-3 backdrop-blur-md">
      <span aria-hidden="true" className="text-[13px] leading-none">
        {daylight ? "☀" : "☾"}
      </span>
      <div className="flex items-baseline gap-2 font-mono text-[12px]">
        <span className="tabular-nums text-white/90">{time}</span>
        <span className="text-white/40">·</span>
        <span className="text-white/60">{label}</span>
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
          live ? "bg-[#F64838]/15 text-[#F64838]" : "bg-white/10 text-white/60",
        )}
      >
        {live && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#F64838]" />
        )}
        {live ? "Live" : "Preview"}
      </span>
    </div>
  );
}

function DayArc({
  hour,
  arcPct,
  daylight,
  onScrub,
}: {
  hour: number;
  arcPct: number;
  daylight: boolean;
  onScrub: (hour: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      onScrub(Math.min(23, Math.round(pct * 24 - 0.5)));
    },
    [onScrub],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons !== 1) return;
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  return (
    <div className="relative flex-1">
      <div
        ref={trackRef}
        // biome-ignore lint/a11y/noStaticElementInteractions: paired with the accessible range input below.
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        className="group relative h-9 cursor-ew-resize touch-none select-none"
      >
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/15" />
        <div className="absolute inset-0 flex items-center justify-between">
          {Array.from({ length: 25 }).map((_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 25-tick ruler; index is the stable identity.
              key={i}
              className={cn("w-px bg-white/20", i % 6 === 0 ? "h-3" : "h-1.5")}
            />
          ))}
        </div>
        <div
          className="absolute top-1/2 left-0 h-px -translate-y-1/2 bg-white/45"
          style={{ width: `${arcPct}%` }}
        />
        <div
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-500 ease-out"
          style={{ left: `${arcPct}%` }}
        >
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-[13px]"
            style={{
              background: daylight
                ? "radial-gradient(circle,#ffd98a,#f6a838)"
                : "radial-gradient(circle,#cfe0ff,#7c8bd6)",
              boxShadow: daylight
                ? "0 0 18px 2px rgba(246,168,56,0.6)"
                : "0 0 16px 1px rgba(124,139,214,0.55)",
            }}
          >
            {daylight ? "☀" : "☾"}
          </span>
        </div>
        <label className="sr-only" htmlFor="dayarc">
          Preview time of day
        </label>
        <input
          id="dayarc"
          type="range"
          min={0}
          max={23}
          step={1}
          value={hour}
          onChange={(e) => onScrub(Number(e.target.value))}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-white/35">
        <span>12 AM</span>
        <span>noon</span>
        <span>12 AM</span>
      </div>
    </div>
  );
}

export function FieldScrim({ variant }: { variant: "stage" | "event" }) {
  if (variant === "event") {
    return (
      <>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-32"
          style={{
            background:
              "linear-gradient(to bottom, rgba(5,1,1,0.6), rgba(5,1,1,0))",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-56"
          style={{
            background:
              "linear-gradient(to top, rgba(5,1,1,0.9), rgba(5,1,1,0))",
          }}
        />
        <div
          aria-hidden="true"
          className="noise pointer-events-none absolute inset-0"
        />
      </>
    );
  }
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "rgba(5,1,1,0.34)" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-36"
        style={{
          background:
            "linear-gradient(to bottom, rgba(5,1,1,0.72), rgba(5,1,1,0))",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(58% 52% at 50% 40%, rgba(5,1,1,0.6), rgba(5,1,1,0) 72%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-72"
        style={{
          background:
            "linear-gradient(to top, rgba(5,1,1,0.95) 0%, rgba(5,1,1,0.6) 35%, rgba(5,1,1,0) 100%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: "inset 0 0 260px 60px rgba(5,1,1,0.5)" }}
      />
      <div
        aria-hidden="true"
        className="noise pointer-events-none absolute inset-0"
      />
    </>
  );
}

/**
 * FieldStage — the whole hero backdrop: lazy frames + scrim + a bottom control
 * bar (live clock + a "Preview the day" toggle that reveals the day-arc). The
 * hero's own overlay content is passed as children.
 */
export function FieldStage({
  config,
  variant = "stage",
  initialHour,
  controls = false,
  children,
}: {
  config: FieldConfig;
  variant?: "stage" | "event";
  /** SSR hour for a fixed-time field (flash-free first paint). */
  initialHour?: number;
  /** Show the clock + "Preview the day" scrubber. Off for normal visitors —
   *  on only when a `?hero=` preview query is present. */
  controls?: boolean;
  children?: ReactNode;
}) {
  const f = useField(config, initialHour);

  return (
    <>
      <FieldStyles />
      <FieldFrames
        config={config}
        shownSlot={f.shownSlot}
        preview={f.preview}
        ready={f.ready}
      />
      <FieldScrim variant={variant} />

      {children}

      {/* bottom control bar — preview affordance, only when opted in */}
      {controls ? (
        <div
          className="dayfield-rise absolute inset-x-0 bottom-0 z-30"
          style={{ animationDelay: "160ms" }}
        >
          <div className="mx-auto max-w-[1256px] px-6 pb-6 md:px-10">
            {f.preview ? (
              <div className="flex items-center gap-4">
                <div className="hidden sm:block">
                  <ClockChip
                    label={f.state.label}
                    time={
                      f.isLive
                        ? f.now
                          ? formatClock(f.now)
                          : "—:—"
                        : formatHour(f.hour)
                    }
                    daylight={f.daylight}
                    live={f.isLive}
                  />
                </div>
                <DayArc
                  hour={f.hour}
                  arcPct={f.arcPct}
                  daylight={f.daylight}
                  onScrub={(h) => f.setPreviewHour(h)}
                />
                <button
                  type="button"
                  onClick={f.exitPreview}
                  className="shrink-0 rounded-full border border-white/20 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-white/80 transition-colors hover:border-white/40"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <ClockChip
                  label={f.state.label}
                  time={f.now ? formatClock(f.now) : "—:—"}
                  daylight={f.daylight}
                  live
                />
                <button
                  type="button"
                  onClick={f.enterPreview}
                  className="shrink-0 rounded-full border border-white/15 bg-black/25 px-4 py-1.5 font-mono text-[11px] uppercase tracking-wide text-white/70 backdrop-blur-md transition-colors hover:border-white/35 hover:text-white"
                >
                  Preview the day ▸
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

export const keyframes = `
  .dayfield-frame { transition: opacity 700ms ease; will-change: opacity; }
  @keyframes dayfield-drift {
    from { transform: scale(1.02) translate3d(0,0,0); }
    to   { transform: scale(1.08) translate3d(-1.5%, -1%, 0); }
  }
  .dayfield-frame { animation: dayfield-drift 46s ease-in-out infinite alternate; }
  @keyframes dayfield-in { from { opacity: 0; } to { opacity: 1; } }
  .dayfield-in { animation: dayfield-drift 46s ease-in-out infinite alternate, dayfield-in 600ms ease both; }
  @keyframes dayfield-rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .dayfield-rise { animation: dayfield-rise 720ms cubic-bezier(0.22,1,0.36,1) both; }
  @media (prefers-reduced-motion: reduce) {
    .dayfield-frame { animation: none !important; }
    .dayfield-rise { animation: none !important; }
  }
`;
