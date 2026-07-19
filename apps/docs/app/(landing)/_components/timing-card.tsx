"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  PRODUCT_ROW_LIST_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductMuted,
  ProductTag,
  productRowClass,
  productRowLabelClass,
} from "./product-card";

/**
 * Timing primitives — the collapse demo. A noisy week of events on top,
 * `ctx.digest` absorbs them into ONE execution, and `ctx.when` lands the
 * single send at Tuesday 09:00 in the READER'S timezone (pick one below and
 * watch the UTC instant move while the local time never does).
 *
 * The event list and counts are illustrative; the timezone math is real
 * (July offsets: PDT −7, CEST +2, JST +9) and the code beside this card is
 * the shipping API.
 */

interface NoisyEvent {
  name: string;
  at: string;
  note: "enrolls" | "absorbed";
}

const WEEK_EVENTS: NoisyEvent[] = [
  { name: "report.shared", at: "mon 14:02", note: "enrolls" },
  { name: "report.shared", at: "mon 19:47", note: "absorbed" },
  { name: "comment.added", at: "tue 03:15", note: "absorbed" },
  { name: "report.shared", at: "wed 08:30", note: "absorbed" },
];

type TzKey = "la" | "berlin" | "tokyo";

const TZ_ORDER: readonly TzKey[] = ["la", "berlin", "tokyo"];

const TIMEZONES: Record<
  TzKey,
  { city: string; iana: string; utc: string; zone: string }
> = {
  la: {
    city: "San Francisco",
    iana: "America/Los_Angeles",
    utc: "16:00 UTC",
    zone: "PDT",
  },
  berlin: {
    city: "Berlin",
    iana: "Europe/Berlin",
    utc: "07:00 UTC",
    zone: "CEST",
  },
  tokyo: {
    city: "Tokyo",
    iana: "Asia/Tokyo",
    utc: "00:00 UTC",
    zone: "JST",
  },
};

export function TimingCard() {
  const [tz, setTz] = useState<TzKey>("berlin");
  const active = TIMEZONES[tz];

  return (
    <ProductCard>
      <ProductCardHeader
        title="weekly-digest"
        tag={<ProductTag>ctx.digest</ProductTag>}
        description="Four events land across the week. One enrolls the journey; the rest are absorbed into the same run and collected at flush."
      />

      {/* The noise — what the week actually looked like. */}
      <div className="border-white/[0.06] border-b px-4 py-3">
        <ul className="space-y-2 font-mono text-[11.5px] tracking-wide">
          {WEEK_EVENTS.map((e, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: static illustrative list
              key={i}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="text-white/60">
                {e.name}
                <span className="ml-2 text-white/30">{e.at}</span>
              </span>
              <span
                className={cn(
                  "rounded-[4px] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em]",
                  e.note === "enrolls"
                    ? "bg-[#f64838]/15 text-[#f8a08f]"
                    : "bg-white/[0.06] text-white/35",
                )}
              >
                {e.note}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* The reader's timezone — where should Tuesday morning land? */}
      <fieldset aria-label="Reader timezone" className={PRODUCT_ROW_LIST_CLASS}>
        {TZ_ORDER.map((key) => {
          const isActive = key === tz;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setTz(key)}
              className={cn(
                "flex items-center justify-between gap-3 text-left outline-none transition-colors",
                productRowClass(isActive),
                !isActive && "hover:bg-white/[0.03]",
              )}
            >
              <span
                className={cn(
                  "transition-colors",
                  productRowLabelClass(isActive),
                )}
              >
                {TIMEZONES[key].city}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                {TIMEZONES[key].iana}
              </span>
            </button>
          );
        })}
      </fieldset>

      {/* The collapse — one send, same local morning, moving UTC instant. */}
      <div aria-live="polite" className="px-4 py-4">
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              "font-normal text-[34px] text-white leading-none tracking-[-0.01em]",
              "[font-family:var(--ps-display)]",
            )}
          >
            Tue 09:00
          </span>
          <span className="font-mono text-[12px] text-white/45">
            {active.zone} · {active.utc}
          </span>
        </div>
        <ProductMuted className="mt-2">
          The local time never moves — the UTC instant does. Timezone resolved
          per reader: PostHog person property → contact property → client
          default → UTC.
        </ProductMuted>
      </div>

      <ProductCardFooter>
        <ProductLabel className="mb-1.5">the week, collapsed</ProductLabel>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1",
            PRODUCT_MONO_VALUE_CLASS,
          )}
        >
          <span className="text-white/55">4 events → 1 send</span>
          <span className="text-white/30">·</span>
          <span className="text-[#f8a08f]">tue 09:00 {active.iana}</span>
        </div>
      </ProductCardFooter>
    </ProductCard>
  );
}
