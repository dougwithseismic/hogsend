"use client";

import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Copy-a-share-link button for course surfaces (videos, podcasts, lessons).
 * Transient "Copied" feedback, styled for the dark card chrome. Distinct from
 * ds/CopyButton, which is code-copy (mono font + code_copied analytics).
 */
export function CopyLinkButton({
  url,
  label = "Copy link",
  className,
}: {
  url: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1.5 text-white/50 text-xs transition-colors hover:text-white",
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden className="size-3.5" strokeWidth={1.5} />
      ) : (
        <Link2 aria-hidden className="size-3.5" strokeWidth={1.5} />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}
