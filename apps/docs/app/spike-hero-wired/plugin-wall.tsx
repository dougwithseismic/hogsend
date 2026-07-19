import { LogoMarquee } from "@/components/ds/marquee";
import { cn } from "@/lib/cn";

/* ==========================================================================
 *  SPIKE — the event-plugin wall, lifted onto the hero.
 *
 *  The list and the flat-silhouette mark are copied from `PsSources` in
 *  app/(landing)/page.tsx, where both are module-private. If this graduates
 *  out of the spike, export them from one place rather than keeping two
 *  copies — this file exists so that duplication is obvious.
 *
 *  Three lanes, alternating direction, each lane's track duplicated so a half
 *  is wider than the viewport (otherwise the -50% wrap reads as a jump — that
 *  is the "not actually infinite" bug).
 * ========================================================================== */

type PluginLogo = {
  name: string;
  file: string;
  ratio: number;
  wordmark?: boolean;
  soon?: boolean;
};

const PLUGIN_LOGOS: PluginLogo[] = [
  { name: "Stripe", file: "stripe.svg", ratio: 1 },
  { name: "Clerk", file: "clerk.svg", ratio: 1 },
  { name: "Supabase", file: "supabase.svg", ratio: 1 },
  { name: "Segment", file: "segment.svg", ratio: 1 },
  { name: "Intercom & Fin", file: "intercom.svg", ratio: 1 },
  {
    name: "Vapi",
    file: "vapi.svg",
    ratio: 33.8 / 9.8,
    wordmark: true,
    soon: true,
  },
  { name: "Twilio", file: "twilio.svg", ratio: 1 },
  { name: "Discord", file: "discord.svg", ratio: 1 },
  { name: "Telegram", file: "telegram.svg", ratio: 1 },
  { name: "PostHog", file: "posthog.svg", ratio: 1 },
  { name: "Resend", file: "resend.svg", ratio: 1 },
  {
    name: "Crisp",
    file: "crisp.svg",
    ratio: 1651 / 647,
    wordmark: true,
    soon: true,
  },
  { name: "Postmark", file: "postmark.svg", ratio: 1 },
  { name: "HubSpot", file: "hubspot.svg", ratio: 1 },
  { name: "Attio", file: "attio.svg", ratio: 103 / 26, wordmark: true },
  { name: "HighLevel", file: "gohighlevel.svg", ratio: 15 / 23 },
  { name: "Meta CAPI", file: "meta.svg", ratio: 1 },
  { name: "Slack", file: "slack.svg", ratio: 1, soon: true },
];

/* One lane, doubled: each half of the marquee track has to be wider than the
   viewport or the -50% wrap reads as a jump — that is the "not actually
   infinite" bug. Eighteen logos twice over clears any realistic width. */
const LANE = [...PLUGIN_LOGOS, ...PLUGIN_LOGOS];

/** A brand SVG painted as a flat silhouette via CSS mask (inherits color). */
function BrandMark({ file, ratio }: { file: string; ratio: number }) {
  const url = `url(/images/logos/${file})`;
  return (
    <span
      aria-hidden="true"
      className="inline-block h-6 bg-current"
      style={{
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        aspectRatio: String(ratio),
      }}
    />
  );
}

export function PluginStrip({ className }: { className?: string }) {
  return (
    <LogoMarquee
      className={className}
      durationSec={90}
      items={LANE.map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static duplicated lane, order is stable
          key={`${l.name}-${i}`}
          className={cn(
            "flex items-center gap-2.5",
            l.soon ? "text-white/35" : "text-white/75",
          )}
          style={{ filter: "drop-shadow(0 2px 10px rgba(5,1,1,0.95))" }}
        >
          <BrandMark file={l.file} ratio={l.ratio} />
          {l.wordmark ? (
            <span className="sr-only">{l.name}</span>
          ) : (
            <span className="whitespace-nowrap text-[15px] tracking-[-0.01em]">
              {l.name}
            </span>
          )}
        </span>
      ))}
    />
  );
}
