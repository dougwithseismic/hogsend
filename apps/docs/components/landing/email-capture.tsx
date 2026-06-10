"use client";

import Link from "next/link";
import { type FormEvent, type JSX, useState } from "react";
import { capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

type Status = "idle" | "submitting" | "success" | "error";

type EmailCaptureProps = {
  className?: string;
  /** Heading above the field. Defaults to the changelog framing. */
  heading?: string;
  /** Supporting line under the heading. */
  sub?: string;
  /** Drop the heading block entirely (the surrounding section supplies it). */
  hideHeading?: boolean;
  /** Where the form is mounted — sent as a non-PII analytics property. */
  placement?: "hero" | "footer";
};

const INPUT_CLASS = cn(
  "h-12 w-full min-w-0 rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
  "outline-none transition-colors duration-200 focus:border-white/20",
  "disabled:opacity-60",
);

/**
 * EmailCapture — email field, optional first-name field, and the primary
 * white button, posting to /api/subscribe (which forwards to the Hogsend
 * ingest API server-side). Input styling matches the ds dark fields: white/4
 * fill, white/8 hairline, 10px radius, h-12; the button mirrors the ds
 * primary Button exactly.
 */
export function EmailCapture({
  className,
  heading = "Get the changelog",
  sub = "Ships when something ships. No drip nonsense.",
  hideHeading = false,
  placement = "footer",
}: EmailCaptureProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");

    const trimmedName = firstName.trim();

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          trimmedName ? { email, firstName: trimmedName } : { email },
        ),
      });
      if (res.ok) {
        setStatus("success");
        capture("capture_form_submitted", { placement });
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className={className}>
      {hideHeading ? null : (
        <>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            {heading}
          </p>
          <p className="mt-1.5 text-sm text-white/50">{sub}</p>
        </>
      )}

      {status === "success" ? (
        <p
          className={cn(
            "flex h-12 items-center gap-2 text-base text-white",
            !hideHeading && "mt-4",
          )}
        >
          <span aria-hidden="true" className="text-accent">
            ✓
          </span>
          You&apos;re on the list.
        </p>
      ) : (
        <>
          <form
            onSubmit={handleSubmit}
            className={cn("flex flex-col gap-3", !hideHeading && "mt-4")}
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                placeholder="First name (optional)"
                aria-label="First name (optional)"
                autoComplete="given-name"
                maxLength={80}
                disabled={status === "submitting"}
                className={cn(INPUT_CLASS, "sm:w-[42%]")}
              />
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                aria-label="Email address"
                autoComplete="email"
                disabled={status === "submitting"}
                className={cn(INPUT_CLASS, "flex-1")}
              />
            </div>
            <button
              type="submit"
              disabled={status === "submitting"}
              className={cn(
                "inline-flex h-12 w-full select-none items-center justify-center",
                "rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base",
                "tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90",
                "disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto sm:self-start",
              )}
            >
              {status === "submitting" ? "Sending…" : "Subscribe"}
            </button>
          </form>

          <p className="mt-3 text-white/40 text-xs leading-5">
            We&apos;ll send the welcome journey and occasional product notes.
            Unsubscribe in one click.{" "}
            <Link
              href="/privacy"
              className="underline underline-offset-2 transition-colors hover:text-white/70"
            >
              Privacy
            </Link>
            .
          </p>

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
