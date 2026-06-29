"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

type CopyButtonProps = {
  value: string;
  className?: string;
};

/**
 * Small copy-to-clipboard button styled for a dark surface. Shows a transient
 * "Copied" state (~1.5s) by swapping the Copy icon for a Check icon. Every
 * copy fires one `code_copied` event — for a code-first product, copying the
 * scaffold command IS the activation signal (filter on `snippet`).
 */
export function CopyButton({ value, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!navigator.clipboard) {
      return;
    }

    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      capture(AnalyticsEvent.CODE_COPIED, { snippet: value.slice(0, 80) });
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[11px] text-white/50 transition-colors hover:text-white",
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
