import { Bell } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SurfacePreview } from "./minted-files";

/* ==========================================================================
 *  The non-email surfaces a run produces.
 *
 *  A journey that DMs on Discord, gates on a Slack approval, or raises an
 *  in-app warning is doing something the code window cannot show. These panes
 *  render what actually lands in front of the person: the message, in the
 *  place it arrives.
 *
 *  Deliberately not pixel-perfect clones of Discord/Slack chrome — enough of
 *  each shape to read at a glance, in our own palette.
 * ========================================================================== */

const BRAND: Record<
  SurfacePreview["kind"],
  { label: string; tint: string; mark?: string }
> = {
  discord: {
    label: "Discord · direct message",
    tint: "#5865f2",
    mark: "discord.svg",
  },
  slack: { label: "Slack · #approvals", tint: "#36c5f0", mark: "slack.svg" },
  telegram: {
    label: "Telegram · direct message",
    tint: "#2aabee",
    mark: "telegram.svg",
  },
  bell: { label: "In-app · notification", tint: "#f64838" },
};

export function SurfacePane({ surface }: { surface: SurfacePreview }) {
  const brand = BRAND[surface.kind];

  return (
    <div className="h-full overflow-auto [scrollbar-width:thin]">
      <div className="flex items-center gap-2 border-white/[0.08] border-b px-4 py-2.5">
        {brand.mark ? (
          <span
            aria-hidden="true"
            className="block size-3.5 shrink-0"
            style={{
              backgroundColor: brand.tint,
              WebkitMaskImage: `url(/images/logos/${brand.mark})`,
              maskImage: `url(/images/logos/${brand.mark})`,
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskPosition: "center",
              maskPosition: "center",
            }}
          />
        ) : (
          <Bell size={13} style={{ color: brand.tint }} className="shrink-0" />
        )}
        <span className="font-mono text-[10px] text-white/45 uppercase tracking-[0.08em]">
          {brand.label}
        </span>
      </div>

      <div className="p-4">
        <div
          className={cn(
            "rounded-[8px] border p-4",
            surface.kind === "bell"
              ? "border-[#f6483840] bg-[#f648380f]"
              : "border-white/10 bg-white/[0.04]",
          )}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white"
              style={{ backgroundColor: brand.tint }}
            >
              {surface.from.slice(0, 1)}
            </span>
            <span className="font-medium text-[13px] text-white/90">
              {surface.from}
            </span>
            <span className="font-mono text-[10px] text-white/30">
              {surface.meta}
            </span>
          </div>

          <p className="mt-3 whitespace-pre-line text-[13px] leading-[1.55] text-white/75">
            {surface.body}
          </p>

          {surface.actions?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {surface.actions.map((action, i) => (
                <span
                  key={action}
                  className={cn(
                    "rounded-[5px] px-3 py-1.5 font-medium text-[12px]",
                    i === 0
                      ? "text-white"
                      : "border border-white/15 text-white/70",
                  )}
                  style={i === 0 ? { backgroundColor: brand.tint } : undefined}
                >
                  {action}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <p className="mt-3 font-mono text-[10px] text-white/25">
          {surface.trigger}
        </p>
      </div>
    </div>
  );
}
