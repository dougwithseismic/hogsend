"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * A monospace value with a copy button. Used for identifiers a customer has to
 * paste into a support message or an API call — the org id today.
 *
 * The button reports what actually happened: it flips to "Copied" only after
 * the clipboard write resolves, and stays put (with the value still selectable)
 * if the browser refuses.
 */
export function CopyValue({
  value,
  label,
  buttonOnly = false,
}: {
  value: string;
  /** Accessible name for the button, e.g. "organization id". */
  label: string;
  /**
   * Render the button alone. For a value already shown above it — a multi-line
   * `.env` fragment in a `<pre>` — where repeating it inline would be noise.
   */
  buttonOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permission — the value is still on screen to select.
      setCopied(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {buttonOnly ? null : (
        <code className="select-all font-mono text-sm text-white/80">
          {value}
        </code>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        className="inline-flex size-7 items-center justify-center rounded-md border border-white/[0.08] text-white/60 transition-colors hover:border-white/20 hover:text-white"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5" strokeWidth={2} />
        ) : (
          <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </span>
  );
}
