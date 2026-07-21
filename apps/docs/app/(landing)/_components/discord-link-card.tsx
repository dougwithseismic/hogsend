"use client";

import { Eye, Gift, Hash, Plus, Smile, Sticker } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductTag,
} from "./product-card";

/**
 * Discord `/link` — the community-channel demo. Four steps walk the REAL bind
 * flow (slash command → email modal → one-click emailed confirm → journey DM),
 * with a simulated Discord `#general` column on the left and the contact record
 * folding in on the right.
 *
 * Honest details preserved: there is no typed code — the bind happens in the
 * browser via the emailed confirm link, and the engine trusts the email the
 * link was issued for, never the Discord-reported one. `last_seen` derives
 * from presence/messages/reactions; a journey DM (`dmMember`) is gated on the
 * member's discord channel preference, and a closed DM is a soft failure.
 *
 * Steps auto-advance until the visitor clicks one — then it's theirs.
 */

/* Accent measured off the comp — the crimzon readout tone. */
const WIRE = "#f4836b";

type StepKey = 0 | 1 | 2 | 3;

const STEPS: Array<{ label: string; detail: string }> = [
  { label: "/link", detail: "slash command" },
  { label: "email modal", detail: "ephemeral" },
  { label: "one-click confirm", detail: "via inbox" },
  { label: "journey DM", detail: "dmMember" },
];

const READOUTS: Array<{ left: string; right: string }> = [
  { left: "POST /interactions", right: "ed25519 verified" },
  { left: "modal_submit", right: "jamie@northwind.io" },
  { left: "contact linked", right: "discord_id folded in" },
  { left: "dmMember", right: "→ delivered: true" },
];

/** Discord-column messages, cumulative per step. */
const CHAT: Array<{
  from: "jamie" | "bot";
  step: StepKey;
  time: string;
  body: string;
  note?: string;
  noteIcon?: "eye";
}> = [
  { from: "jamie", step: 0, time: "11:12 AM", body: "/link" },
  {
    from: "bot",
    step: 1,
    time: "11:12 AM",
    body: "Link your account — what's your email?",
    note: "only you can see this",
    noteIcon: "eye",
  },
  {
    from: "bot",
    step: 2,
    time: "11:12 AM",
    body: "Check your inbox — one click confirms it's you.",
    note: "the bind happens in the browser, engine-verified",
  },
  {
    from: "bot",
    step: 3,
    time: "11:14 AM",
    body: "Hey Jamie — 10 reports shared this week. Your team digest is live.",
    note: "sent by a journey · respects their channel preference",
  },
];

/** Contact-record lines, keyed by the step they appear at. */
const CONTACT_LINES: Array<{ step: StepKey; k: string; v: string }> = [
  { step: 0, k: "email", v: "jamie@northwind.io" },
  { step: 2, k: "discord_id", v: "882140…" },
  { step: 2, k: "isDiscordLinked", v: "true" },
  { step: 3, k: "last_seen", v: "2m ago · presence" },
];

/**
 * The Hogsend boar mark, painted in `currentColor` via CSS mask (same
 * technique as the nav lockup) so it inherits the avatar's crimzon tint.
 */
function BoarMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block bg-current", className)}
      style={{
        WebkitMaskImage: "url(/images/logos/hogsend-boar.svg)",
        maskImage: "url(/images/logos/hogsend-boar.svg)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

export function DiscordLinkCard() {
  const [step, setStep] = useState<StepKey>(0);
  const [manual, setManual] = useState(false);

  // Auto-advance until the visitor takes over.
  useEffect(() => {
    if (manual) return;
    const t = setInterval(() => {
      setStep((s) => ((s + 1) % STEPS.length) as StepKey);
    }, 2400);
    return () => clearInterval(t);
  }, [manual]);

  function choose(next: StepKey) {
    setManual(true);
    setStep(next);
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
      {/* LEFT — the Discord #general column, in the same product-card kit. */}
      <ProductCard>
        {/* Channel header. */}
        <div className="flex items-center gap-2 border-white/[0.08] border-b px-4 py-3">
          <Hash className="size-[18px] text-white/35" strokeWidth={2.25} />
          <span className="font-semibold text-[15px] text-white tracking-[-0.01em]">
            general
          </span>
          <span className="ml-auto font-mono text-[10px] text-white/30 uppercase tracking-[0.16em]">
            your server
          </span>
        </div>

        {/* Messages. */}
        <div className="flex min-h-[320px] flex-col gap-5 px-4 py-4">
          {CHAT.filter((m) => m.step <= step).map((m) => {
            const isJamie = m.from === "jamie";
            return (
              <div key={m.body} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full font-semibold text-[14px]",
                    isJamie
                      ? "bg-white/[0.08] text-white/70"
                      : "bg-[#f64838]/20 text-[#f8a08f]",
                  )}
                >
                  {isJamie ? "J" : <BoarMark className="h-[18px] w-[32px]" />}
                </span>
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <span className="font-semibold text-[15px] text-white tracking-[-0.01em]">
                      {isJamie ? "jamie" : "Hogsend"}
                    </span>
                    {m.from === "bot" && (
                      <span className="rounded-[4px] bg-[#f64838]/20 px-1.5 py-px align-middle font-semibold text-[9px] text-[#f8a08f] uppercase tracking-[0.06em]">
                        bot
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-white/35">
                      {m.time}
                    </span>
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-[15px] leading-[22px] tracking-[-0.01em]",
                      m.body === "/link"
                        ? "font-mono text-[#93b4f8]"
                        : "text-white/75",
                    )}
                  >
                    {m.body}
                  </p>
                  {m.note && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-white/35 tracking-[-0.01em]">
                      {m.noteIcon === "eye" && (
                        <Eye className="size-3.5 shrink-0" strokeWidth={2} />
                      )}
                      {m.note}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Message composer (decorative). */}
        <div className="px-4 pb-4">
          <div className="flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70">
              <Plus className="size-4" strokeWidth={2.5} />
            </span>
            <span className="flex-1 text-[15px] text-white/30 tracking-[-0.01em]">
              Message #general
            </span>
            <div className="flex items-center gap-3 text-white/40">
              <Gift className="size-[18px]" strokeWidth={2} />
              <span className="rounded-[4px] border border-white/25 px-1 font-semibold text-[10px] leading-[14px] tracking-wide">
                GIF
              </span>
              <Sticker className="size-[18px]" strokeWidth={2} />
              <Smile className="size-[18px]" strokeWidth={2} />
            </div>
          </div>
        </div>
      </ProductCard>

      {/* RIGHT — the flow steps + the contact record folding in. */}
      <ProductCard>
        <ProductCardHeader
          title="discord-connect"
          tag={
            <ProductTag tone="crimzon" pulse>
              live flow
            </ProductTag>
          }
          description="One slash command folds a Discord account onto the contact — verified through their inbox, never the Discord-reported email."
        />

        <div className="px-4 py-3">
          <fieldset
            aria-label="Flow step"
            className="overflow-hidden rounded-lg border border-white/[0.08]"
          >
            {STEPS.map((s, i) => {
              const isActive = i === step;
              return (
                <button
                  key={s.label}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => choose(i as StepKey)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left outline-none transition-colors",
                    i > 0 && "border-white/[0.06] border-t",
                    isActive ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center font-mono text-[13px] tracking-[-0.01em] transition-colors",
                      isActive ? "text-white" : "text-white/55",
                    )}
                  >
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="ps-caret mr-px text-white/80"
                      >
                        |
                      </span>
                    )}
                    {s.label}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-white/35 uppercase tracking-[0.1em]">
                    {s.detail}
                  </span>
                </button>
              );
            })}
          </fieldset>
        </div>

        <div
          aria-live="polite"
          className="border-white/[0.08] border-t px-4 py-4"
        >
          <ProductLabel className="mb-2.5">contact</ProductLabel>
          <div className="space-y-1.5 font-mono text-[11.5px] tracking-wide">
            {CONTACT_LINES.map((l) => {
              const landed = l.step <= step;
              return (
                <p
                  key={l.k}
                  className={cn(
                    "flex items-baseline justify-between gap-3 transition-opacity duration-500",
                    landed ? "opacity-100" : "opacity-25",
                  )}
                >
                  <span className="text-white/60">{l.k}</span>
                  <span style={landed ? { color: WIRE } : undefined}>
                    {landed ? l.v : <span className="text-white/35">—</span>}
                  </span>
                </p>
              );
            })}
          </div>
        </div>

        <ProductCardFooter>
          <ProductLabel className="mb-1.5">on the wire</ProductLabel>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1",
              PRODUCT_MONO_VALUE_CLASS,
            )}
          >
            <span className="text-white/55">{READOUTS[step].left}</span>
            <span style={{ color: WIRE }}>{READOUTS[step].right}</span>
          </div>
        </ProductCardFooter>
      </ProductCard>
    </div>
  );
}
