"use client";

import { type FormEvent, type JSX, useState } from "react";
import { cn } from "@/lib/cn";

type Status = "idle" | "submitting" | "success" | "error";

/**
 * EmailCapture — single email field + the primary white button, posting to
 * /api/subscribe (which forwards to the Hogsend ingest API server-side).
 * Input styling matches the ds dark fields: white/4 fill, white/8 hairline,
 * 10px radius, h-12; the button mirrors the ds primary Button exactly.
 */
export function EmailCapture({
  className,
}: {
  className?: string;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setStatus(res.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className={className}>
      <p className="font-medium text-base text-white tracking-[-0.02em]">
        Get the changelog
      </p>
      <p className="mt-1.5 text-sm text-white/50">
        Ships when something ships. No drip nonsense.
      </p>

      {status === "success" ? (
        <p className="mt-4 flex h-12 items-center gap-2 text-base text-white">
          <span aria-hidden="true" className="text-accent">
            ✓
          </span>
          You&apos;re on the list.
        </p>
      ) : (
        <>
          <form
            onSubmit={handleSubmit}
            className="mt-4 flex flex-col gap-3 sm:flex-row"
          >
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              aria-label="Email address"
              autoComplete="email"
              disabled={status === "submitting"}
              className={cn(
                "h-12 w-full min-w-0 flex-1 rounded-[10px] border border-white/[0.08]",
                "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
                "outline-none transition-colors duration-200 focus:border-white/20",
                "disabled:opacity-60",
              )}
            />
            <button
              type="submit"
              disabled={status === "submitting"}
              className={cn(
                "inline-flex h-12 shrink-0 select-none items-center justify-center",
                "rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base",
                "tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90",
                "disabled:cursor-not-allowed disabled:opacity-70",
              )}
            >
              {status === "submitting" ? "Sending…" : "Subscribe"}
            </button>
          </form>

          {status === "error" ? (
            <p className="mt-3 text-sm text-white/70">
              That didn&apos;t take. Try again.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
