"use client";

import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type JSX, useState } from "react";
import {
  AnalyticsEvent,
  capture,
  getDistinctId,
  identify,
  sessionIdentity,
} from "@/lib/analytics";
import { cn } from "@/lib/cn";

type Step = "form" | "role" | "website" | "done";

type Status = "idle" | "submitting" | "error";

type EmailCaptureProps = {
  className?: string;
  /** Heading above the field. Defaults to the changelog framing. */
  heading?: string;
  /** Supporting line under the heading. */
  sub?: string;
  /** Drop the heading block entirely (the surrounding section supplies it). */
  hideHeading?: boolean;
  /** Where the form is mounted — sent as a non-PII analytics property. */
  placement?: "hero" | "footer" | "referral";
};

/**
 * The qualification answers. Values are the closed set /api/profile accepts;
 * labels are what the visitor sees.
 */
const ROLE_OPTIONS = [
  { value: "founder", label: "Founder" },
  { value: "engineer", label: "Engineer" },
  { value: "marketing_growth", label: "Marketing / Growth" },
  { value: "sales", label: "Sales" },
  { value: "just_curious", label: "Just curious" },
] as const;

const INPUT_CLASS = cn(
  "h-12 w-full min-w-0 rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
  "outline-none transition-colors duration-200 focus:border-white/20",
  "disabled:opacity-60",
);

const PANEL_CLASS = cn(
  "flex flex-col items-center gap-3 rounded-[10px] border",
  "border-white/[0.08] bg-white/[0.04] px-6 py-8 text-center",
);

const CHIP_CLASS = cn(
  "h-10 select-none rounded-[10px] border border-white/[0.08] bg-white/[0.02]",
  "px-4 text-sm text-white/80 transition-colors duration-200",
  "hover:border-white/20 hover:text-white",
);

const SKIP_CLASS =
  "text-white/40 text-xs transition-colors hover:text-white/70";

/**
 * EmailCapture — multistep capture. Step one is the stacked first-name +
 * email form posting to /api/subscribe (which forwards to the Hogsend ingest
 * API server-side), so the subscription lands no matter what happens after.
 * Two optional follow-ups — what's your seat, and got a website — each post
 * independently to /api/profile as contact properties; dropping off keeps
 * everything answered so far. Input styling matches the ds dark fields; the
 * button mirrors the ds primary Button exactly.
 */
export function EmailCapture({
  className,
  heading = "Get the changelog",
  sub = "Ships when something ships. No drip nonsense.",
  hideHeading = false,
  placement = "footer",
}: EmailCaptureProps): JSX.Element {
  const [step, setStep] = useState<Step>("form");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [website, setWebsite] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  /** Best-effort enrichment — never blocks the step flow. */
  function postProfile(fields: { role?: string; website?: string }) {
    fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), ...fields }),
      keepalive: true,
    }).catch(() => {});
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");

    const trimmedName = firstName.trim();
    const distinctId = getDistinctId();

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(trimmedName ? { firstName: trimmedName } : {}),
          ...(distinctId ? { posthogDistinctId: distinctId } : {}),
          termsAccepted,
          productNotes,
        }),
      });
      if (res.ok) {
        // Session identity (in-memory only, cookieless) lets later deploy
        // clicks in this browsing session reach the docs-subscriber journey
        // via /api/deploy-clicked.
        sessionIdentity.email = email.trim().toLowerCase();
        // Identify the session under the contact's canonical Hogsend key (an
        // opaque id, no PII) — the same PostHog person the contact's email
        // events land on, and the one hs_t email clicks resolve to.
        const { contactKey } = (await res.json().catch(() => ({}))) as {
          contactKey?: string;
        };
        if (contactKey) identify(contactKey);
        capture(AnalyticsEvent.CAPTURE_SUBMITTED, {
          placement,
          product_notes: productNotes,
        });
        setStatus("idle");
        setStep("role");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  function handleRole(role: string) {
    capture(AnalyticsEvent.ROLE_SELECTED, { role, placement });
    postProfile({ role });
    setStep("website");
  }

  function handleWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = website.trim();
    if (trimmed) {
      // The URL itself goes to Hogsend as a contact property — PostHog only
      // hears that one was provided.
      capture(AnalyticsEvent.WEBSITE_PROVIDED, { placement });
      postProfile({ website: trimmed });
    }
    setStep("done");
  }

  return (
    <div className={className}>
      {hideHeading || step !== "form" ? null : (
        <>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            {heading}
          </p>
          <p className="mt-1.5 text-sm text-white/50">{sub}</p>
        </>
      )}

      {step === "form" ? (
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
      ) : null}

      {step === "role" ? (
        <div className={cn(PANEL_CLASS, !hideHeading && "mt-4")}>
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-tint text-accent">
            <Check aria-hidden="true" className="size-5" strokeWidth={2} />
          </span>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            You&apos;re in.
          </p>
          <p className="max-w-sm text-sm text-white/60 leading-5">
            While you&apos;re here — what&apos;s your seat? It shapes what we
            send.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {ROLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleRole(option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep("website")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </div>
      ) : null}

      {step === "website" ? (
        <div className={cn(PANEL_CLASS, !hideHeading && "mt-4")}>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            One more — got a website?
          </p>
          <p className="max-w-sm text-sm text-white/60 leading-5">
            We&apos;ll point the examples at your stack. Optional.
          </p>
          <form
            onSubmit={handleWebsite}
            className="flex w-full max-w-sm flex-col gap-3 sm:flex-row"
          >
            <input
              type="text"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="yourcompany.com"
              aria-label="Website (optional)"
              autoComplete="url"
              maxLength={200}
              className={cn(INPUT_CLASS, "flex-1")}
            />
            <button
              type="submit"
              className={cn(
                "inline-flex h-12 select-none items-center justify-center",
                "rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a]",
                "text-base tracking-[-0.02em] transition-colors duration-200",
                "hover:bg-white/90 sm:shrink-0",
              )}
            >
              Done
            </button>
          </form>
          <button
            type="button"
            onClick={() => setStep("done")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </div>
      ) : null}

      {step === "done" ? (
        <div className={cn(PANEL_CLASS, !hideHeading && "mt-4")}>
          <span className="flex size-10 items-center justify-center rounded-full bg-accent-tint text-accent">
            <Check aria-hidden="true" className="size-5" strokeWidth={2} />
          </span>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            All set.
          </p>
          <p className="max-w-sm text-sm text-white/60 leading-5">
            Look out for your first getting-started email — it&apos;s on its way
            from hello@hogsend.com.
          </p>
        </div>
      ) : null}
    </div>
  );
}
