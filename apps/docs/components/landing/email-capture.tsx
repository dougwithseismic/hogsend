"use client";

import { ArrowRight, Check } from "lucide-react";
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
 * EmailCapture — stacked first-name + email fields and the full-width primary
 * button, posting to /api/subscribe (which forwards to the Hogsend ingest API
 * server-side). Input styling matches the ds dark fields: white/4 fill,
 * white/8 hairline, 10px radius, h-12; the button mirrors the ds primary
 * Button exactly (white fill, near-black text, trailing arrow). On success
 * the form swaps for a confirmation panel.
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
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);
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
        body: JSON.stringify({
          email,
          ...(trimmedName ? { firstName: trimmedName } : {}),
          termsAccepted,
          productNotes,
        }),
      });
      if (res.ok) {
        setStatus("success");
        capture("capture_form_submitted", { placement, productNotes });
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
        <div
          className={cn(
            "flex flex-col items-center gap-3 rounded-[10px] border",
            "border-white/[0.08] bg-white/[0.04] px-6 py-8 text-center",
            !hideHeading && "mt-4",
          )}
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-tint text-accent">
            <Check aria-hidden="true" className="size-5" strokeWidth={2} />
          </span>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            You&apos;re in.
          </p>
          <p className="max-w-sm text-sm text-white/60 leading-5">
            Look out for your first getting-started email — it&apos;s on its way
            from hello@hogsend.com.
          </p>
        </div>
      ) : (
        <>
          <form
            onSubmit={handleSubmit}
            className={cn("flex flex-col gap-3", !hideHeading && "mt-4")}
          >
            <input
              type="text"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              placeholder="First name (optional)"
              aria-label="First name (optional)"
              autoComplete="given-name"
              maxLength={80}
              disabled={status === "submitting"}
              className={INPUT_CLASS}
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
              className={INPUT_CLASS}
            />
            <button
              type="submit"
              disabled={status === "submitting"}
              className={cn(
                "group inline-flex h-12 w-full select-none items-center",
                "justify-center gap-2 rounded-[10px] bg-white px-5 font-medium",
                "text-[#0a0a0a] text-base tracking-[-0.02em] transition-colors",
                "duration-200 hover:bg-white/90 disabled:cursor-not-allowed",
                "disabled:opacity-70",
              )}
            >
              <span>{status === "submitting" ? "Sending…" : "Subscribe"}</span>
              {status === "submitting" ? null : (
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
                  strokeWidth={2}
                />
              )}
            </button>

            <div className="mt-1 flex flex-col gap-2.5 text-left">
              <label className="flex items-start gap-2.5 text-white/50 text-xs leading-5">
                <input
                  type="checkbox"
                  required
                  checked={termsAccepted}
                  onChange={(event) => setTermsAccepted(event.target.checked)}
                  disabled={status === "submitting"}
                  className="mt-1 size-3.5 shrink-0 accent-accent"
                />
                <span>
                  I agree to the{" "}
                  <Link
                    href="/terms"
                    className="underline underline-offset-2 transition-colors hover:text-white/70"
                  >
                    terms
                  </Link>{" "}
                  and{" "}
                  <Link
                    href="/privacy"
                    className="underline underline-offset-2 transition-colors hover:text-white/70"
                  >
                    privacy policy
                  </Link>
                  . The welcome journey arrives by email.
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-white/50 text-xs leading-5">
                <input
                  type="checkbox"
                  checked={productNotes}
                  onChange={(event) => setProductNotes(event.target.checked)}
                  disabled={status === "submitting"}
                  className="mt-1 size-3.5 shrink-0 accent-accent"
                />
                <span>
                  Send me product notes when something ships. Optional —
                  unsubscribe is one click either way.
                </span>
              </label>
            </div>
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
