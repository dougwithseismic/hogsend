"use client";

import {
  Braces,
  Check,
  Copy,
  Repeat2,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { useRef, useState } from "react";
import { FieldStage } from "@/app/spike-daylight/dayfield-shared";
import { getFieldConfig } from "@/app/spike-daylight/field-config";
import { ThermalHover } from "@/components/ds/thermal";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { PluginStrip } from "./plugin-wall";
import { SessionStage } from "./session-stage";

/* ==========================================================================
 *  The homepage hero: a headline column beside a live agent session.
 *
 *  The first screen answers three questions for the buyer in docs/MARKET.md
 *  (a technical founder or product engineer at a product-led company):
 *  who it is for (the eyebrow), the outcome (the subhead's first sentence)
 *  and why this instead of a canvas tool or a hand-rolled stack (the
 *  headline, then the batteries sentence). It has ONE call to action: the
 *  copyable scaffold command. Everything else is a quiet text link or lives
 *  below the fold.
 *
 *  The CLI replay is the hero object. Every file a run writes is minted into
 *  its own draggable window as the terminal prints it — journeys as source,
 *  emails as a rendered template, Discord/Slack/in-app messages as the
 *  surface they land on. See `session-stage.tsx` for the windowing.
 *
 *  Backdrop is the day-field vista lit to the visitor's local hour; the
 *  palette is the site's crimzon throughout. Windowing is desktop-only —
 *  below `xl` this degrades to the docked terminal alone.
 * ========================================================================== */

const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest";
const DISPLAY = "[font-family:var(--ff-display)]";
const ACCENT = "#f64838";

/** The wedge, unpacked: what a DIY drip stack does not give you. */
const PILLARS = [
  {
    icon: Braces,
    title: "Typed journeys in your repo",
    body: "Each journey is a TypeScript file next to your product code. Review it in a pull request; CI type-checks and tests it.",
  },
  {
    icon: Repeat2,
    title: "Exactly-once sends",
    body: "Durable waits and sends that survive crashes, retries and redeploys without messaging anyone twice.",
  },
  {
    icon: ShieldCheck,
    title: "Unsubscribe and suppression",
    body: "Preference center, one-click unsubscribe, bounce and complaint suppression on every send.",
  },
  {
    icon: ServerCog,
    title: "On infrastructure you own",
    body: "First-party open and click tracking and identity in your own Postgres, with the email provider you already use.",
  },
] as const;

/* -------------------------------------------------------------------------- */

/**
 * The hero's one call to action: the whole command is the button. Copying
 * fires the same `docs.code_copied` event as every CopyButton, so the
 * activation funnel (filter on `snippet`) is unchanged.
 */
function InstallCommand() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      capture(AnalyticsEvent.CODE_COPIED, { snippet: INSTALL_COMMAND });
    });
  }

  return (
    <ThermalHover intensity="bold" className="w-full max-w-[400px]">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy the install command: ${INSTALL_COMMAND}`}
        className="group flex w-full cursor-pointer items-center gap-3 rounded-[6px] border border-white/25 bg-black/55 py-3 pr-3.5 pl-4 text-left backdrop-blur-md transition-colors hover:border-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f64838]/70"
      >
        <code className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono text-[13px] text-white sm:text-[14px]">
          <span className="text-white/40">$ </span>
          {INSTALL_COMMAND}
        </code>
        <span
          aria-live="polite"
          className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-white/60 transition-colors group-hover:text-white"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          )}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </span>
      </button>
    </ThermalHover>
  );
}

export function WiredHeroSection({
  engineVersion,
  highlighted,
  configId,
}: {
  engineVersion?: string;
  highlighted: Record<string, React.ReactNode>;
  configId?: string;
}) {
  const config = getFieldConfig(configId);
  // windows are portalled here: outside the copy/terminal grid's stacking
  // context, but still inside the hero so they scroll away with it
  const heroRef = useRef<HTMLElement>(null);

  return (
    <section
      ref={heroRef}
      className="relative min-h-[100svh] overflow-hidden text-white"
    >
      <FieldStage config={config} variant="stage">
        <div className="relative z-20 mx-auto flex min-h-[100svh] w-full max-w-[1400px] flex-col justify-center px-6 pt-28 pb-10 md:px-10">
          {/* ---- the stage: copy one third, session panel two thirds ---- */}
          <div className="relative grid items-center gap-10 xl:grid-cols-[1fr_2fr] xl:gap-14">
            {/* copy column */}
            <div className="relative z-30 max-w-[600px] xl:max-w-none">
              {/* who it is for — plain words, not a link */}
              <p className="font-mono text-[11px] text-white/60 uppercase tracking-[0.1em]">
                For product engineers and technical founders
              </p>

              {/* why us: the wedge — journeys are code in the buyer's repo */}
              <h1
                className={cn(
                  "mt-4 text-balance font-normal text-[40px] leading-[1.04] tracking-[-0.03em] md:text-[56px] xl:text-[52px]",
                  DISPLAY,
                )}
                style={{ textShadow: "0 2px 44px rgba(5,1,1,0.55)" }}
              >
                Lifecycle messaging as code in your repo.
              </h1>

              {/* the outcome, then the batteries a DIY stack lacks. Kept to
                  five lines at 1440 and 390 so the command clears the
                  first-visit consent card (fixed bottom-left, ~280px tall) */}
              <p className="mt-5 max-w-[520px] text-[16px] text-white/80 leading-relaxed md:text-lg">
                When a customer signs up, stalls in a trial or stops paying,
                Hogsend runs the follow-up. Journeys go through pull requests
                and CI like the rest of your code. Exactly-once sends,
                unsubscribes and suppression are built in, on infrastructure you
                own.
              </p>

              {/* the one call to action, with a single quiet text link */}
              <div className="mt-7 flex flex-col items-start gap-3">
                <InstallCommand />
                <p className="text-[13px] text-white/55">
                  Scaffolds the app, Docker services and starter journeys.{" "}
                  <a
                    href="/docs/getting-started"
                    className="whitespace-nowrap text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline"
                  >
                    Read the quickstart →
                  </a>
                </p>
              </div>
            </div>

            {/* ---- the CLI session + the file it minted ---- */}
            {/* the terminal deliberately stops short of the column's right
                edge — the minted file window parks in the gap it leaves */}
            <SessionStage
              engineVersion={engineVersion}
              highlighted={highlighted}
              className="relative z-30 min-w-0 xl:max-w-[560px]"
              portalTarget={heroRef}
            />
          </div>

          {/* ---- event plugins, three lanes ---- */}
          <div className="relative z-30 mt-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-white/50">
              Event plugins
            </p>
            <PluginStrip className="mt-4" />
          </div>

          {/* ---- pillars ---- */}
          <div className="relative z-30 mt-10 grid gap-8 border-white/10 border-t pt-8 sm:grid-cols-2 xl:grid-cols-4">
            {PILLARS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex gap-3">
                <span
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[6px] border"
                  style={{
                    borderColor: `${ACCENT}55`,
                    background: `${ACCENT}1a`,
                  }}
                >
                  <Icon size={14} style={{ color: ACCENT }} />
                </span>
                <div>
                  <p className="text-[15px] text-white">{title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-white/60">
                    {body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </FieldStage>
    </section>
  );
}
