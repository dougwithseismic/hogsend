"use client";

import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import {
  AnalyticsEvent,
  capture,
  getDistinctId,
  identify,
  sessionIdentity,
} from "@/lib/analytics";
import { cn } from "@/lib/cn";

type Step = "intent" | "role" | "provider" | "website" | "form" | "done";

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
  /**
   * Live-demo order: ask the qualification questions (intent → seat →
   * provider) FIRST, captured anonymously under the PostHog distinct_id, then
   * the email step last. The post-subscribe identify() stitches those earlier
   * anonymous events to the now-known contact, and the answers are flushed to
   * /api/profile as contact properties. Off (default) keeps the email-first
   * order with the seat/website follow-ups after signup.
   */
  qualifyFirst?: boolean;
};

/**
 * The qualification answers. Values are the closed sets /api/profile accepts;
 * labels are what the visitor sees.
 */
const ROLE_OPTIONS = [
  { value: "founder", label: "Founder" },
  { value: "engineer", label: "Engineer" },
  { value: "marketing_growth", label: "Marketing / Growth" },
  { value: "sales", label: "Sales" },
  { value: "just_curious", label: "Just curious" },
] as const;

const INTENT_OPTIONS = [
  { value: "replacing_tool", label: "Replacing Loops / Customer.io" },
  { value: "posthog_lifecycle", label: "Adding lifecycle to PostHog + Resend" },
  { value: "client_work", label: "Building for clients" },
  { value: "exploring", label: "Just exploring" },
] as const;

const PROVIDER_OPTIONS = [
  { value: "resend", label: "Resend" },
  { value: "postmark", label: "Postmark" },
  { value: "sendgrid", label: "SendGrid" },
  { value: "other", label: "Something else" },
  { value: "none", label: "Nothing yet" },
] as const;

/** Keyboard focus ring shared by every interactive control. */
const FOCUS_RING = cn(
  "focus-visible:outline focus-visible:outline-2",
  "focus-visible:outline-offset-2 focus-visible:outline-white/50",
);

const INPUT_CLASS = cn(
  "h-12 w-full min-w-0 rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.04] px-4 text-base text-white placeholder:text-white/40",
  "outline-none transition-colors duration-200 focus:border-white/20",
  "disabled:opacity-60",
);

const PANEL_CLASS = cn(
  "flex min-w-0 flex-col items-center gap-3 rounded-[10px] border",
  "border-white/[0.08] bg-white/[0.04] px-6 py-8 text-center outline-none",
);

const CHIP_CLASS = cn(
  "min-h-10 select-none rounded-[10px] border border-white/[0.08]",
  "bg-white/[0.02] px-4 py-2 text-center text-sm text-white/80",
  "transition-colors duration-200 hover:border-white/20 hover:text-white",
  FOCUS_RING,
);

const SKIP_CLASS = cn(
  "rounded-[4px] px-2 py-1 text-white/60 text-xs transition-colors",
  "hover:text-white/80",
  FOCUS_RING,
);

const STEP_COUNT_CLASS = "text-white/50 text-xs tracking-[0.08em]";

/**
 * EmailCapture — multistep capture with two orders. Default (footer/referral):
 * the first-name + email form first (posting to /api/subscribe, which forwards
 * to the Hogsend ingest API server-side, so the subscription lands no matter
 * what happens after), then the seat + website follow-ups posting to
 * /api/profile. With `qualifyFirst` (the live demo): intent → seat → provider
 * are asked first and captured anonymously, the email form is last, and the
 * answers are flushed to /api/profile once the email is known. Input styling
 * matches the ds dark fields; the button mirrors the ds primary Button.
 */
export function EmailCapture({
  className,
  heading = "Get the changelog",
  sub = "One email when something ships, and nothing in between.",
  hideHeading = false,
  placement = "footer",
  qualifyFirst = false,
}: EmailCaptureProps): JSX.Element {
  const [step, setStep] = useState<Step>(qualifyFirst ? "intent" : "form");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [website, setWebsite] = useState("");
  const [intentValue, setIntentValue] = useState("");
  const [roleValue, setRoleValue] = useState("");
  const [providerValue, setProviderValue] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // Move focus into the freshly rendered step on each change so keyboard and
  // screen-reader users aren't stranded on the control that just unmounted —
  // the step's fieldset announces its aria-label on focus. Skip the first
  // render so we never auto-focus (and scroll to) the demo on page load.
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (step === "form") {
      nameRef.current?.focus();
    } else {
      groupRef.current?.focus();
    }
  }, [step]);

  /** Best-effort enrichment — never blocks the step flow. */
  function postProfile(fields: {
    role?: string;
    website?: string;
    intent?: string;
    provider?: string;
  }) {
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
        // Identify the session under the contact's canonical Hogsend key (a
        // stable opaque id) — the same PostHog person the contact's email
        // events land on, and the one hs_t email clicks resolve to. In the
        // qualifyFirst order this is the stitch: the intent/seat/provider
        // events fired anonymously above now join this identified person.
        // The required terms checkbox gates submission, so consent is present:
        // attach email + name as person properties so the contact is
        // identifiable in PostHog, not just an opaque key.
        const { contactKey } = (await res.json().catch(() => ({}))) as {
          contactKey?: string;
        };
        if (contactKey) {
          identify(contactKey, {
            email: email.trim().toLowerCase(),
            ...(trimmedName ? { name: trimmedName } : {}),
          });
        }
        capture(AnalyticsEvent.CAPTURE_SUBMITTED, {
          placement,
          product_notes: productNotes,
        });
        setStatus("idle");
        if (qualifyFirst) {
          // Flush the answers gathered before the email as contact
          // properties, mirroring the post-signup steps' /api/profile writes.
          const profileFields = {
            ...(roleValue ? { role: roleValue } : {}),
            ...(intentValue ? { intent: intentValue } : {}),
            ...(providerValue ? { provider: providerValue } : {}),
          };
          if (Object.keys(profileFields).length > 0) {
            postProfile(profileFields);
          }
          setStep("done");
        } else {
          setStep("role");
        }
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  function handleIntent(intent: string) {
    capture(AnalyticsEvent.INTENT_SELECTED, { intent, placement });
    setIntentValue(intent);
    setStep("role");
  }

  function handleRole(role: string) {
    capture(AnalyticsEvent.ROLE_SELECTED, { role, placement });
    if (qualifyFirst) {
      // No email yet — hold the answer and post it after subscribe.
      setRoleValue(role);
      setStep("provider");
    } else {
      postProfile({ role });
      setStep("website");
    }
  }

  function handleProvider(provider: string) {
    capture(AnalyticsEvent.PROVIDER_SELECTED, { provider, placement });
    setProviderValue(provider);
    setStep("form");
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
      {hideHeading || step !== "form" || qualifyFirst ? null : (
        <>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            {heading}
          </p>
          <p className="mt-1.5 text-sm text-white/50">{sub}</p>
        </>
      )}

      {step === "intent" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Step 1 of 3: What brings you here?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            1 / 3
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            What brings you here?
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {INTENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleIntent(option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep("role")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </fieldset>
      ) : null}

      {step === "role" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label={
            qualifyFirst
              ? "Step 2 of 3: What's your seat?"
              : "What's your seat?"
          }
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          {qualifyFirst ? (
            <p aria-hidden="true" className={STEP_COUNT_CLASS}>
              2 / 3
            </p>
          ) : (
            <span className="flex size-10 items-center justify-center rounded-full bg-accent-tint text-accent">
              <Check aria-hidden="true" className="size-5" strokeWidth={2} />
            </span>
          )}
          {qualifyFirst ? null : (
            <p className="font-medium text-base text-white tracking-[-0.02em]">
              You&apos;re in.
            </p>
          )}
          <p
            className={
              qualifyFirst
                ? "font-medium text-base text-white tracking-[-0.02em]"
                : "max-w-sm text-sm text-white/60 leading-5"
            }
          >
            {qualifyFirst
              ? "What's your seat?"
              : "While you're here — what's your seat? It shapes what we send."}
          </p>
          {qualifyFirst ? (
            <p className="text-sm text-white/60 leading-5">
              It shapes what we send.
            </p>
          ) : null}
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
            onClick={() => setStep(qualifyFirst ? "provider" : "website")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </fieldset>
      ) : null}

      {step === "provider" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Step 3 of 3: What are you sending email with?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            3 / 3
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            What are you sending email with?
          </p>
          <p className="max-w-sm text-sm text-white/60 leading-5">
            Resend and Postmark have first-class adapters — the wire is
            swappable.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {PROVIDER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleProvider(option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep("form")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </fieldset>
      ) : null}

      {step === "form" ? (
        <>
          {qualifyFirst ? (
            <div className="mb-4 text-center">
              <p className="font-medium text-base text-white tracking-[-0.02em]">
                Want to watch it run?
              </p>
              <p className="mt-1.5 text-sm text-white/60 leading-5">
                Your email fires the welcome journey — it arrives from
                hello@hogsend.com in seconds.
              </p>
            </div>
          ) : null}
          <form
            onSubmit={handleSubmit}
            className={cn(
              "flex flex-col gap-3",
              !hideHeading && !qualifyFirst && "mt-4",
            )}
          >
            <input
              ref={nameRef}
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
                FOCUS_RING,
              )}
            >
              <span>
                {status === "submitting"
                  ? "Sending…"
                  : qualifyFirst
                    ? "Get the demo"
                    : "Subscribe"}
              </span>
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

      {step === "website" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Add your website"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
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
                FOCUS_RING,
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
        </fieldset>
      ) : null}

      {step === "done" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="All set"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
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
        </fieldset>
      ) : null}
    </div>
  );
}
