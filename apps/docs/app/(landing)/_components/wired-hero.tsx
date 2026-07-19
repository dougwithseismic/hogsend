"use client";

import { Braces, LineChart, Radio, Workflow } from "lucide-react";
import { FieldStage } from "@/app/spike-daylight/dayfield-shared";
import { getFieldConfig } from "@/app/spike-daylight/field-config";
import { CopyButton } from "@/components/ds/copy-button";
import { ThermalHover } from "@/components/ds/thermal";
import { cn } from "@/lib/cn";
import { PluginStrip } from "./plugin-wall";
import { SessionStage } from "./session-stage";

/* ==========================================================================
 *  The homepage hero: a headline column beside a live agent session.
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

const PILLARS = [
  {
    icon: Braces,
    title: "Code-first",
    body: "Journeys are TypeScript in your repo. Version, review and ship them like the rest of your product.",
  },
  {
    icon: Workflow,
    title: "Full-funnel",
    body: "Onboarding, activation, retention, monetization — one engine across every stage.",
  },
  {
    icon: Radio,
    title: "Event-powered",
    body: "React to any event from your product, your warehouse or any webhook source.",
  },
  {
    icon: LineChart,
    title: "Measure impact",
    body: "Built-in experiments, holdouts and lift measurement on every journey.",
  },
] as const;

/* -------------------------------------------------------------------------- */

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

  return (
    <section className="relative min-h-[100svh] overflow-hidden text-white">
      <FieldStage config={config} variant="stage">
        <div className="relative z-20 mx-auto flex min-h-[100svh] w-full max-w-[1400px] flex-col justify-center px-6 pt-28 pb-10 md:px-10 md:pt-32">
          {/* ---- the stage: copy one third, session panel two thirds ---- */}
          <div className="relative grid items-center gap-10 xl:grid-cols-[1fr_2fr] xl:gap-14">
            {/* copy column */}
            <div className="relative z-30 max-w-[600px] xl:max-w-none">
              <a
                href="https://course.hogsend.com"
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 py-1 pr-3 pl-1 text-[12px] backdrop-blur-md sm:text-[13px]"
              >
                <span className="rounded-full bg-[#f64838] px-2.5 py-0.5 font-medium">
                  New
                </span>
                <span className="font-medium">Measure → Keep → Grow</span>
                <span className="text-white/50">· Live</span>
              </a>

              <h1
                className={cn(
                  "mt-6 text-balance font-normal text-[42px] leading-[1.04] tracking-[-0.03em] md:text-[56px] xl:text-[52px]",
                  DISPLAY,
                )}
                style={{ textShadow: "0 2px 44px rgba(5,1,1,0.55)" }}
              >
                Build lifecycle journeys that grow your product.
              </h1>

              <p className="mt-6 max-w-[520px] text-[16px] leading-relaxed text-white/80 md:text-lg">
                The lifecycle automation framework for growth engineering teams
                that ship code. Journeys live in your repo, reviewed and
                versioned like the rest of your product.
              </p>

              {/* the copy column is a third of the stage, so the CTAs stack
                  rather than fighting for one line at xl */}
              <div className="mt-8 flex flex-col items-start gap-3">
                <ThermalHover intensity="bold">
                  <span className="flex min-w-0 items-center gap-2 rounded-[6px] border border-white/15 bg-black/45 py-2.5 pr-2 pl-4 backdrop-blur-md">
                    <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-white/90 [scrollbar-width:none]">
                      <span className="text-white/40">$ </span>
                      {INSTALL_COMMAND}
                    </code>
                    <CopyButton
                      value={INSTALL_COMMAND}
                      className="shrink-0 text-white/50 hover:text-white"
                    />
                  </span>
                </ThermalHover>
                <a
                  href="/docs"
                  className="text-[14px] text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline"
                >
                  View docs →
                </a>
              </div>
            </div>

            {/* ---- the CLI session + the file it minted ---- */}
            {/* the terminal deliberately stops short of the column's right
                edge — the minted file window parks in the gap it leaves */}
            <SessionStage
              engineVersion={engineVersion}
              highlighted={highlighted}
              className="relative z-30 min-w-0 xl:max-w-[560px]"
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
