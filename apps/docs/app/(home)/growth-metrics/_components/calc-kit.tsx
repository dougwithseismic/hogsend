"use client";

/* ========================================================================== */
/*  Growth-metrics calculator kit.                                            */
/*                                                                            */
/*  Shared primitives for the interactive growth explainer: currency context, */
/*  fixed-locale formatters (SSR-safe — never locale-dependent), accessible   */
/*  sliders / number fields, stat tiles, verdict pills, the ripple chain, and */
/*  the term tooltip. Everything is dark-crimzon by default; the only colour  */
/*  beyond the red accent is the scoped data-viz palette (good=teal,          */
/*  caution=amber, warn=accent) defined in app/global.css.                    */
/* ========================================================================== */

import {
  createContext,
  Fragment,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { GLOSS, type GlossEntry, type GlossId } from "./glossary-data";

/* -------------------------------------------------------------------------- */
/*  Currency                                                                   */
/* -------------------------------------------------------------------------- */

export type CurrencySymbol = "£" | "$" | "€";

const CURRENCY_SYMBOLS: CurrencySymbol[] = ["£", "$", "€"];

type CurrencyContextValue = {
  symbol: CurrencySymbol;
  setSymbol: (symbol: CurrencySymbol) => void;
};

const CurrencyContext = createContext<CurrencyContextValue>({
  symbol: "£",
  setSymbol: () => {},
});

export function CurrencyProvider({
  children,
  initial = "£",
}: {
  children: ReactNode;
  initial?: CurrencySymbol;
}): JSX.Element {
  const [symbol, setSymbol] = useState<CurrencySymbol>(initial);
  return (
    <CurrencyContext.Provider value={{ symbol, setSymbol }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}

/** Segmented £ / $ / € control. Wire it once near the top of the page. */
export function CurrencyToggle({
  className,
}: {
  className?: string;
}): JSX.Element {
  const { symbol, setSymbol } = useCurrency();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented toggle wants role="group", not a fieldset/legend
    <div
      role="group"
      aria-label="Currency"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1",
        className,
      )}
    >
      {CURRENCY_SYMBOLS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setSymbol(value)}
          aria-pressed={symbol === value}
          className={cn(
            "size-7 rounded-md font-mono text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
            symbol === value
              ? "bg-white text-ink"
              : "text-white/55 hover:text-white",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Formatters — fixed locale so SSR and client render byte-identical.        */
/* -------------------------------------------------------------------------- */

const LOCALE = "en-US";

export function fmtMoney(n: number, symbol: string, dp = 0): string {
  if (!Number.isFinite(n)) return "∞";
  return (
    symbol +
    new Intl.NumberFormat(LOCALE, {
      maximumFractionDigits: dp,
      minimumFractionDigits: dp,
    }).format(n)
  );
}

export function fmtNum(n: number, dp = 0): string {
  if (!Number.isFinite(n)) return "∞";
  return new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: dp,
    minimumFractionDigits: dp,
  }).format(n);
}

export function fmtPct(n: number, dp = 0): string {
  return `${Number.isFinite(n) ? n.toFixed(dp) : "∞"}%`;
}

export function fmtMul(n: number, dp = 2): string {
  return Number.isFinite(n) ? `${n.toFixed(dp)}×` : "∞";
}

/** Money formatter bound to the active currency symbol. */
export function useMoney(): (n: number, dp?: number) => string {
  const { symbol } = useCurrency();
  return (n: number, dp = 0) => fmtMoney(n, symbol, dp);
}

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/* -------------------------------------------------------------------------- */
/*  Tone — the scoped data-viz palette.                                       */
/* -------------------------------------------------------------------------- */

export type Tone = "good" | "warn" | "caution" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-good",
  warn: "text-accent",
  caution: "text-caution",
  neutral: "text-white",
};

const TONE_DOT: Record<Tone, string> = {
  good: "bg-good",
  warn: "bg-accent",
  caution: "bg-caution",
  neutral: "bg-white/40",
};

const TONE_NODE: Record<Tone, string> = {
  good: "border-good/50 bg-good-tint",
  warn: "border-accent/50 bg-accent-tint",
  caution: "border-caution/50 bg-caution-tint",
  neutral: "border-white/[0.08] bg-white/[0.03]",
};

/** Raw CSS values — for SVG fill/stroke attributes where classes can't reach. */
export const TONE_VAR: Record<Tone, string> = {
  good: "var(--color-good)",
  warn: "var(--color-accent)",
  caution: "var(--color-caution)",
  neutral: "rgba(255,255,255,0.45)",
};

export function toneText(tone: Tone): string {
  return TONE_TEXT[tone];
}

/* -------------------------------------------------------------------------- */
/*  Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

/** Raised calculator panel — the standard surface for an interactive widget. */
export function CalcPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 sm:p-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Grey explanatory paragraph that sits under a heading or above controls. */
export function CalcNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p className={cn("max-w-3xl text-sm text-white/55 leading-6", className)}>
      {children}
    </p>
  );
}

/** Faint "try this" hint line. */
export function Hint({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <p
      className={cn(
        "mt-3 text-[12.5px] text-white/45 leading-relaxed",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Inline monospace formula / code fragment. */
export function Formula({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <code
      className={cn(
        "rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[12.5px] text-white/85",
        className,
      )}
    >
      {children}
    </code>
  );
}

/* -------------------------------------------------------------------------- */
/*  Controls                                                                   */
/* -------------------------------------------------------------------------- */

const COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

type SliderProps = {
  /** Visible + accessible name. */
  /** Accessible name (always a plain string). */
  label: string;
  /** Optional rich visible label (e.g. wrapping a <Term>); falls back to label. */
  labelNode?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Fired on release (pointer up / arrow-key up) — use for analytics. */
  onCommit?: () => void;
  /** Formatted current value shown on the right of the label row. */
  display: string;
};

/** Crimzon range slider with an accessible name and a live formatted readout. */
export function Slider({
  label,
  labelNode,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  display,
}: SliderProps): JSX.Element {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px] text-white/60">
        <span>{labelNode ?? label}</span>
        <span className="font-mono text-[13px] text-white tabular-nums">
          {display}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={display}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onPointerUp={onCommit}
        onKeyUp={(event) => {
          if (COMMIT_KEYS.has(event.key)) onCommit?.();
        }}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/[0.08] outline-none focus-visible:ring-1 focus-visible:ring-accent/60 [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
      />
    </div>
  );
}

type NumberFieldProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
};

/** Compact numeric input (flex child — pair with NumberRow). */
export function NumberField({
  label,
  value,
  onChange,
  min,
  step,
  prefix,
  suffix,
}: NumberFieldProps): JSX.Element {
  const id = useId();
  return (
    <div className="min-w-[120px] flex-1">
      <label htmlFor={id} className="mb-1.5 block text-[11.5px] text-white/55">
        {label}
      </label>
      <div className="flex items-center rounded-lg border border-white/[0.08] bg-white/[0.03] focus-within:border-accent/60">
        {prefix ? (
          <span className="pl-2.5 font-mono text-sm text-white/40">
            {prefix}
          </span>
        ) : null}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className="w-full bg-transparent px-2.5 py-2 font-mono text-sm text-white tabular-nums outline-none"
        />
        {suffix ? (
          <span className="pr-2.5 font-mono text-sm text-white/40">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Flex-wrap row for NumberFields. */
export function NumberRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex flex-wrap gap-2.5", className)}>{children}</div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Readouts                                                                   */
/* -------------------------------------------------------------------------- */

type StatProps = {
  k: ReactNode;
  n: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
};

/** A single stat tile: uppercase label, big mono number, optional subline. */
export function Stat({
  k,
  n,
  sub,
  tone = "neutral",
  className,
}: StatProps): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5",
        className,
      )}
    >
      <div className="mb-1.5 text-[10.5px] text-white/50 uppercase tracking-[0.07em]">
        {k}
      </div>
      <div
        className={cn(
          "font-bold font-mono text-[21px] tabular-nums tracking-[-0.02em]",
          toneText(tone),
        )}
      >
        {n}
      </div>
      {sub ? (
        <div className="mt-1 font-mono text-[11px] text-white/40">{sub}</div>
      ) : null}
    </div>
  );
}

/** Auto-fit grid of Stat tiles. */
export function StatGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Verdict pill with a coloured status dot. */
export function Verdict({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 font-mono text-[12.5px]",
        toneText(tone),
      )}
    >
      <span className={cn("size-2 rounded-full", TONE_DOT[tone])} />
      <span>{children}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ripple chain — input → derived → derived, recolouring as it ripples.      */
/* -------------------------------------------------------------------------- */

export type ChainNode = {
  k: ReactNode;
  n: ReactNode;
  d?: ReactNode;
  tone?: Tone;
};

export function RippleChain({ nodes }: { nodes: ChainNode[] }): JSX.Element {
  return (
    <div className="flex flex-wrap items-stretch gap-y-2">
      {nodes.map((node, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
        <Fragment key={index}>
          {index > 0 ? (
            <div className="flex flex-[0_0_1.5rem] items-center justify-center font-mono text-white/30 max-[640px]:basis-full max-[640px]:rotate-90">
              →
            </div>
          ) : null}
          <div
            className={cn(
              "min-w-[120px] flex-1 rounded-xl border p-3 transition-colors duration-300",
              TONE_NODE[node.tone ?? "neutral"],
            )}
          >
            <div className="mb-1.5 text-[10px] text-white/50 uppercase tracking-[0.06em]">
              {node.k}
            </div>
            <div className="font-bold font-mono text-[18px] tabular-nums">
              {node.n}
            </div>
            {node.d ? (
              <div className="mt-1 font-mono text-[10.5px] text-white/40">
                {node.d}
              </div>
            ) : null}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Term tooltip — hover/focus/tap definition popover, keyboard accessible.    */
/* -------------------------------------------------------------------------- */

type TermTooltipProps = {
  term: ReactNode;
  definition: ReactNode;
  formula?: ReactNode;
};

export function TermTooltip({
  term,
  definition,
  formula,
}: TermTooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-help border-white/30 border-b border-dotted font-medium text-white outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent"
      >
        {term}
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="-translate-x-1/2 absolute bottom-full left-1/2 z-30 mb-2 w-64 rounded-lg border border-white/15 bg-ink/95 p-3 text-left font-sans text-[13px] text-white/80 normal-case leading-5 shadow-black/50 shadow-xl backdrop-blur-md"
        >
          {formula ? (
            <span className="mb-1.5 block font-mono text-[12px] text-accent">
              {formula}
            </span>
          ) : null}
          <span className="block font-normal">{definition}</span>
        </span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Glossary tooltip — one floating popover shared by every inline <Term>.     */
/*  A single fixed-position element avoids the clipping/z-index problems of    */
/*  per-instance tooltips when terms sit inside panels. Hover/focus shows it;  */
/*  click pins it (Escape / scroll / outside-click dismiss).                  */
/* -------------------------------------------------------------------------- */

type ActiveTerm = { id: GlossId; rect: DOMRect; pinned: boolean };

type GlossaryContextValue = {
  show: (id: GlossId, el: HTMLElement) => void;
  hide: (force: boolean) => void;
  togglePin: (id: GlossId, el: HTMLElement) => void;
};

const GlossaryContext = createContext<GlossaryContextValue | null>(null);

export function GlossaryProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [active, setActive] = useState<ActiveTerm | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = useCallback((id: GlossId, el: HTMLElement) => {
    setActive((prev) =>
      prev?.pinned
        ? prev
        : { id, rect: el.getBoundingClientRect(), pinned: false },
    );
  }, []);

  const hide = useCallback((force: boolean) => {
    setActive((prev) => (prev?.pinned && !force ? prev : null));
  }, []);

  const togglePin = useCallback((id: GlossId, el: HTMLElement) => {
    setActive((prev) =>
      prev?.id === id && prev.pinned
        ? null
        : { id, rect: el.getBoundingClientRect(), pinned: true },
    );
  }, []);

  // Position the tooltip once it (and the trigger rect) are known.
  useEffect(() => {
    if (!active) {
      setPos(null);
      return;
    }
    const tip = tipRef.current;
    if (!tip) return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const r = active.rect;
    const left = clamp(
      r.left + r.width / 2 - w / 2,
      8,
      window.innerWidth - w - 8,
    );
    let top = r.top - h - 9;
    if (top < 8) top = r.bottom + 9;
    setPos({ left, top });
  }, [active]);

  // Dismiss on scroll / resize / Escape / outside-click.
  useEffect(() => {
    if (!active) return;
    const onScrollResize = () => hide(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide(true);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-term]") || target?.closest("[data-gloss-tip]"))
        return;
      hide(true);
    };
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [active, hide]);

  const value = useMemo<GlossaryContextValue>(
    () => ({ show, hide, togglePin }),
    [show, hide, togglePin],
  );

  const entry: GlossEntry | null = active ? GLOSS[active.id] : null;

  return (
    <GlossaryContext.Provider value={value}>
      {children}
      {active && entry ? (
        <div
          ref={tipRef}
          data-gloss-tip=""
          role="tooltip"
          className="fixed z-[60] w-72 max-w-[calc(100vw-16px)] rounded-xl border border-white/15 bg-ink/95 p-3.5 text-left shadow-black/60 shadow-xl backdrop-blur-md"
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            visibility: pos ? "visible" : "hidden",
          }}
        >
          <span className="mb-1.5 block font-mono text-[11px] text-accent uppercase tracking-[0.05em]">
            {entry.title}
          </span>
          <span className="block text-[13px] text-white/80 leading-5">
            {entry.plain}
          </span>
          {entry.formula ? (
            <span className="mt-2 block font-mono text-[11px] text-white/45">
              {entry.formula}
            </span>
          ) : null}
        </div>
      ) : null}
    </GlossaryContext.Provider>
  );
}

function useGlossary(): GlossaryContextValue {
  const ctx = useContext(GlossaryContext);
  if (!ctx) {
    throw new Error("useGlossary must be used within a GlossaryProvider");
  }
  return ctx;
}

/**
 * Inline glossary term — a dotted-underline trigger that opens the shared
 * floating definition. `id` keys into GLOSS; children override the visible
 * label (defaults to the id). Keyboard accessible; click pins the tooltip.
 */
export function Term({
  id,
  children,
  className,
}: {
  id: GlossId;
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  const { show, hide, togglePin } = useGlossary();
  const ref = useRef<HTMLButtonElement>(null);
  const entry = GLOSS[id];
  return (
    <button
      ref={ref}
      type="button"
      data-term=""
      aria-label={`${entry.title}. ${entry.plain}`}
      onMouseEnter={() => ref.current && show(id, ref.current)}
      onMouseLeave={() => hide(false)}
      onFocus={() => ref.current && show(id, ref.current)}
      onBlur={() => hide(false)}
      onClick={() => ref.current && togglePin(id, ref.current)}
      className={cn(
        "cursor-help rounded-[2px] border-white/30 border-b border-dotted text-inherit outline-none transition-colors hover:border-accent focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
    >
      {children ?? id}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Explainer — a collapsible plain-English panel under a calculator. Native   */
/*  <details>, so it works without JS and is keyboard/SSR-safe.               */
/* -------------------------------------------------------------------------- */

export function Explainer({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <details
      className={cn(
        "group mt-4 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 font-mono text-[12px] text-white/60 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-white/20 text-[11px] text-accent"
        >
          <span className="group-open:hidden">?</span>
          <span className="hidden group-open:inline">–</span>
        </span>
        <span>{summary}</span>
      </summary>
      <div className="[&_b]:font-semibold [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_b]:text-white/90 border-white/[0.08] border-t px-4 py-4 text-[13.5px] text-white/65 leading-relaxed [&_p+p]:mt-3 [&_p]:mt-0">
        {children}
      </div>
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section intro — the always-visible teaching paragraph under a heading.     */
/* -------------------------------------------------------------------------- */

export function SectionIntro({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "mt-6 max-w-2xl space-y-3 text-[15px] text-white/70 leading-7 [&_b]:font-medium [&_b]:text-white/90",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Fig — an inline, emphasised live value used inside running prose.          */
/* -------------------------------------------------------------------------- */

export function Fig({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: Tone;
}): JSX.Element {
  return (
    <span
      className={cn(
        "font-medium font-mono tabular-nums",
        tone ? toneText(tone) : "text-white",
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  MeansForYou — the live "so what does this mean for you?" callout. The      */
/*  sentence inside reads back the current inputs/results, recolouring its     */
/*  left rule by the section's health tone.                                    */
/* -------------------------------------------------------------------------- */

const MEANS_BORDER: Record<Tone, string> = {
  good: "border-l-good",
  warn: "border-l-accent",
  caution: "border-l-caution",
  neutral: "border-l-white/40",
};

const MEANS_LABEL: Record<Tone, string> = {
  good: "text-good",
  warn: "text-accent",
  caution: "text-caution",
  neutral: "text-accent",
};

export function MeansForYou({
  tone = "neutral",
  label = "So what does this mean for you?",
  children,
}: {
  tone?: Tone;
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        "mt-6 rounded-xl border border-white/[0.08] border-l-2 bg-white/[0.02] p-5",
        MEANS_BORDER[tone],
      )}
    >
      <p
        className={cn(
          "mb-2 font-mono text-[11px] uppercase tracking-[0.08em]",
          MEANS_LABEL[tone],
        )}
      >
        {label}
      </p>
      <p className="text-[15px] text-white/85 leading-7">{children}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Play — the "what to do about it" block: concrete moves + a prompt. This    */
/*  is the action layer that sits beside the numbers (the what) and the        */
/*  explainer (the why).                                                       */
/* -------------------------------------------------------------------------- */

export function Play({
  heading = "What to do about it",
  moves,
  consider,
}: {
  heading?: string;
  moves: ReactNode[];
  consider?: ReactNode;
}): JSX.Element {
  return (
    <div className="mt-6 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
      <p className="mb-3.5 flex items-center gap-2 font-mono text-[11px] text-good uppercase tracking-[0.08em]">
        <span aria-hidden="true">▸</span>
        {heading}
      </p>
      <ul className="flex flex-col gap-2.5">
        {moves.map((move, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
            key={index}
            className="flex gap-2.5 text-[14px] text-white/75 leading-6"
          >
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-good" />
            <span>{move}</span>
          </li>
        ))}
      </ul>
      {consider ? (
        <p className="mt-4 border-white/[0.06] border-t pt-3.5 text-[13.5px] text-white/55 leading-6">
          <span className="font-medium text-caution">
            Have you thought about
          </span>{" "}
          {consider}
        </p>
      ) : null}
    </div>
  );
}
