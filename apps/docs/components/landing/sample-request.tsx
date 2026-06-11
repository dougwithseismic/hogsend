"use client";

import { type FormEvent, type JSX, useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/** Mirrors EmailCapture's field styling so the gallery input feels native. */
const INPUT_CLASS = cn(
  "h-12 w-full min-w-0 rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
  "outline-none transition-colors duration-200 focus:border-white/20",
  "disabled:opacity-60",
);

/**
 * Templates already requested this browsing session. Module-level and
 * in-memory only (no cookies, no storage) — matches the site's cookieless
 * posture: the "On its way." state survives client-side navigation but not a
 * full page load. The server's daily idempotency key backstops repeats.
 */
const sentTemplates = new Set<string>();

type Status = "idle" | "open" | "submitting" | "error" | "sent";

type SampleRequestProps = {
  /** Backend template registry key, e.g. "activation/welcome". */
  template: string;
  className?: string;
};

/**
 * SampleRequest — the per-card "Email me this one" affordance on /emails.
 * A text trigger reveals a compact email + send row posting to /api/sample,
 * which forwards a `docs.sample_requested` event; the dogfood app sends the
 * actual rendered template. The address goes to the ingest API only — PostHog
 * hears the template key, never the email.
 */
export function SampleRequest({
  template,
  className,
}: SampleRequestProps): JSX.Element {
  const [status, setStatus] = useState<Status>(() =>
    sentTemplates.has(template) ? "sent" : "idle",
  );
  const [email, setEmail] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");

    try {
      const res = await fetch("/api/sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), template }),
      });
      if (res.ok) {
        sentTemplates.add(template);
        capture(AnalyticsEvent.SAMPLE_REQUESTED, { template });
        setStatus("sent");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className={cn("border-white/[0.08] border-t pt-4", className)}>
        <p className="text-sm text-white/60 tracking-[-0.02em]">On its way.</p>
      </div>
    );
  }

  if (status === "idle") {
    return (
      <div className={cn("border-white/[0.08] border-t pt-4", className)}>
        <button
          type="button"
          onClick={() => setStatus("open")}
          className="text-sm text-white/80 tracking-[-0.02em] transition-colors hover:text-white"
        >
          Email me this one →
        </button>
      </div>
    );
  }

  return (
    <div className={cn("border-white/[0.08] border-t pt-4", className)}>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="email"
          required
          // biome-ignore lint/a11y/noAutofocus: revealed by an explicit click
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          aria-label="Email address for the sample"
          autoComplete="email"
          disabled={status === "submitting"}
          className={cn(INPUT_CLASS, "h-10 flex-1 px-3 text-sm")}
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className={cn(
            "inline-flex h-10 shrink-0 select-none items-center justify-center",
            "rounded-[10px] bg-white px-4 font-medium text-[#0a0a0a] text-sm",
            "tracking-[-0.02em] transition-colors duration-200",
            "hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-70",
          )}
        >
          {status === "submitting" ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="mt-2 text-white/40 text-xs leading-5">
        {status === "error"
          ? "That didn't take. Try again."
          : "Sent from the same engine the docs run on."}
      </p>
    </div>
  );
}
