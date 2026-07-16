"use client";

import { Check, Copy } from "lucide-react";
import { type JSX, useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/**
 * CopyPlayPrompt — the play's install path. One click copies the whole play
 * (steps, the Hogsend reference snippet, the success metric) wrapped as an
 * "implement this" prompt, ready to paste into a coding agent. The copy
 * fires `docs.play_prompt_copied` on both analytics legs' shared PostHog
 * capture (the strongest read-intent signal a play emits).
 */
export function CopyPlayPrompt({
  slug,
  prompt,
  className,
}: {
  slug: string;
  prompt: string;
  className?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(prompt);
    capture(AnalyticsEvent.PLAY_PROMPT_COPIED, { slug });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className={cn(
        "rounded-md border border-white/[0.08] bg-white/[0.015] p-4",
        className,
      )}
    >
      <p className="font-mono text-[11px] text-white/45 uppercase tracking-[0.06em]">
        Run this play
      </p>
      <button
        type="button"
        onClick={copy}
        className="mt-3 inline-flex h-9 w-full select-none items-center justify-center gap-2 rounded-[6px] bg-white px-4 font-medium text-[#0a0606] text-[13px] tracking-[-0.02em] transition-opacity hover:opacity-85"
      >
        {copied ? (
          <>
            <Check className="size-3.5 text-accent" strokeWidth={2} />
            Copied
          </>
        ) : (
          <>
            <Copy className="size-3.5" strokeWidth={2} />
            Copy for your agent
          </>
        )}
      </button>
    </div>
  );
}
