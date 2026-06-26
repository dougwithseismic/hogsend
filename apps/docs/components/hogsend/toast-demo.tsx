"use client";

import { ToastContainer, useToast } from "@hogsend/react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

/**
 * Live `<Toast>` demo + a token theme-switcher in one. "Pop a toast" fires a
 * real ephemeral `@hogsend/js` toast (client-local — no engine round-trip),
 * rendered bottom-right via `<ToastContainer>`. The three skin chips re-color
 * it by overriding `--hs-*` tokens.
 *
 * The override is set ON the `.hsr-toast` element via a scoped selector (not an
 * ancestor inline var): the element carries `.hsr`, which declares its own
 * `--hs-color-accent`, and an element's own declaration beats a value inherited
 * from an ancestor — so a `.hs-toast-skin .hsr-toast` rule (with `!important`)
 * is what actually re-skins it. The `<ToastContainer>` is fixed-positioned but
 * a DOM descendant of `.hs-toast-skin`, so the selector still matches.
 *
 * Gated on `isHogsendConfigured` so the docs build (no engine wired) renders
 * nothing rather than needing a client.
 */
export function ToastDemo() {
  if (!isHogsendConfigured) return null;
  return <ToastDemoLive />;
}

const SKINS = [
  { id: "crimzon", label: "Crimzon", accent: "#f64838" },
  { id: "indigo", label: "Indigo", accent: "#6366f1" },
  { id: "emerald", label: "Emerald", accent: "#10b981" },
] as const;

const MESSAGES = [
  {
    title: "Your export is ready",
    body: "A real @hogsend/js toast — ephemeral, dismissible, themed by tokens.",
  },
  {
    title: "Payment received",
    body: "Toasts fire client-side from useToast().show — no engine round-trip.",
  },
  {
    title: "New reply from Doug",
    body: "Click routes through the SDK, so inapp.toast_clicked still fires.",
  },
] as const;

function ToastDemoLive() {
  const { show } = useToast();
  const [skin, setSkin] = useState<(typeof SKINS)[number]>(SKINS[0]);
  const [i, setI] = useState(0);

  function pop() {
    const msg = MESSAGES[i % MESSAGES.length];
    setI((n) => n + 1);
    show({
      type: "info",
      title: msg.title,
      body: msg.body,
      actionUrl: "https://hogsend.com/docs/client-side",
      metadata: {},
    });
  }

  return (
    <div className="hs-toast-skin">
      {/* Scoped token override — see the component doc comment for why it must
          target `.hsr-toast`, not an ancestor. */}
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: derived from a fixed allowlist of hex accents
        dangerouslySetInnerHTML={{
          __html: `.hs-toast-skin .hsr-toast{--hs-color-accent:${skin.accent}!important;--hs-color-badge-bg:${skin.accent}!important;--hs-color-unread-dot:${skin.accent}!important}`,
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={pop}
          className={cn(
            "inline-flex h-11 select-none items-center justify-center rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-sm transition-colors",
            "hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
          )}
        >
          Pop a toast
        </button>

        <span className="text-[12px] text-white/40">Skin</span>
        <div className="inline-flex gap-1.5">
          {SKINS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSkin(s)}
              aria-pressed={skin.id === s.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[13px] transition-colors",
                skin.id === s.id
                  ? "border-white/25 bg-white/[0.08] text-white"
                  : "border-white/[0.08] bg-white/[0.02] text-white/55 hover:text-white",
              )}
            >
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ background: s.accent }}
              />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-3 text-[12px] text-white/40 leading-5">
        Fires <code className="font-mono text-white/60">useToast().show()</code>{" "}
        — it renders bottom-right via{" "}
        <code className="font-mono text-white/60">&lt;ToastContainer&gt;</code>,
        re-skinned by the{" "}
        <code className="font-mono text-white/60">--hs-*</code> tokens you pick.
        No CVA, no design lock-in.
      </p>

      <ToastContainer placement="bottom-right" aria-label="Demo toasts" />
    </div>
  );
}
