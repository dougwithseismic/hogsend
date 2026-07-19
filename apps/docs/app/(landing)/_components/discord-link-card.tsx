"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  PRODUCT_ROW_LIST_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductTag,
  productRowClass,
  productRowLabelClass,
} from "./product-card";

/**
 * Discord `/link` — the community-channel demo. Four steps walk the REAL bind
 * flow (slash command → email modal → one-click emailed confirm → journey DM),
 * with a simulated Discord column on the left and the contact record folding
 * in on the right.
 *
 * Honest details preserved: there is no typed code — the bind happens in the
 * browser via the emailed confirm link, and the engine trusts the email the
 * link was issued for, never the Discord-reported one. `last_seen` derives
 * from presence/messages/reactions; a journey DM (`dmMember`) is gated on the
 * member's discord channel preference, and a closed DM is a soft failure.
 *
 * Steps auto-advance until the visitor clicks one — then it's theirs.
 */

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
  body: string;
  note?: string;
}> = [
  { from: "jamie", step: 0, body: "/link" },
  {
    from: "bot",
    step: 1,
    body: "Link your account — what's your email?",
    note: "only you can see this",
  },
  {
    from: "bot",
    step: 2,
    body: "Check your inbox — one click confirms it's you.",
    note: "the bind happens in the browser, engine-verified",
  },
  {
    from: "bot",
    step: 3,
    body: "Hey Jamie — 10 reports shared this week. Your team digest is live.",
    note: "sent by a journey · respects their channel preference",
  },
];

/** Contact-record lines, keyed by the step they appear at. */
const CONTACT_LINES: Array<{ step: StepKey; k: string; v: string }> = [
  { step: 0, k: "email", v: '"jamie@northwind.io"' },
  { step: 2, k: "discord_id", v: '"882140…"' },
  { step: 2, k: "isDiscordLinked", v: "true" },
  { step: 3, k: "last_seen", v: "2m ago · presence" },
];

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
      {/* LEFT — the Discord column, as far as the flow has advanced. */}
      <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
        <div className="flex items-center gap-2 border-white/[0.08] border-b px-4 py-2.5">
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            #general
          </span>
          <span className="ml-auto font-mono text-[10px] text-white/30 uppercase tracking-[0.08em]">
            your server
          </span>
        </div>
        <div className="space-y-4 px-4 py-5 min-h-[280px]">
          {CHAT.filter((m) => m.step <= step).map((m) => (
            <div key={m.body} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full font-medium text-[11px]",
                  m.from === "jamie"
                    ? "bg-white/[0.08] text-white/70"
                    : "bg-[#f64838]/20 text-[#f8a08f]",
                )}
              >
                {m.from === "jamie" ? "J" : "H"}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-[13px] text-white/75">
                  {m.from === "jamie" ? "jamie" : "Hogsend"}
                  {m.from === "bot" && (
                    <span className="ml-1.5 rounded-[3px] bg-[#f64838]/20 px-1 py-px align-middle font-mono text-[9px] text-[#f8a08f] uppercase tracking-[0.08em]">
                      bot
                    </span>
                  )}
                </p>
                <p
                  className={cn(
                    "mt-0.5 text-sm leading-[21px] tracking-[-0.02em]",
                    m.body === "/link"
                      ? "font-mono text-[#93b4f8]"
                      : "text-white/65",
                  )}
                >
                  {m.body}
                </p>
                {m.note && (
                  <p className="mt-1 text-white/35 text-xs tracking-[-0.02em]">
                    {m.note}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

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

        <fieldset aria-label="Flow step" className={PRODUCT_ROW_LIST_CLASS}>
          {STEPS.map((s, i) => {
            const isActive = i === step;
            return (
              <button
                key={s.label}
                type="button"
                aria-pressed={isActive}
                onClick={() => choose(i as StepKey)}
                className={cn(
                  "flex items-center justify-between gap-3 text-left outline-none transition-colors",
                  productRowClass(isActive),
                  !isActive && "hover:bg-white/[0.03]",
                )}
              >
                <span
                  className={cn(
                    "font-mono transition-colors",
                    productRowLabelClass(isActive),
                  )}
                >
                  {s.label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                  {s.detail}
                </span>
              </button>
            );
          })}
        </fieldset>

        <div aria-live="polite" className="px-4 py-4">
          <ProductLabel className="mb-2">contact</ProductLabel>
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
                  <span className={landed ? "text-[#f8a08f]" : "text-white/35"}>
                    {landed ? l.v : "—"}
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
            <span className="text-[#f8a08f]">{READOUTS[step].right}</span>
          </div>
        </ProductCardFooter>
      </ProductCard>
    </div>
  );
}
