"use client";

import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import {
  AnalyticsEvent,
  capture,
  getDistinctId,
  grantConsent,
  sessionIdentity,
} from "@/lib/analytics";
import { cn } from "@/lib/cn";

/**
 * Steps. The default (footer/referral) machine is `form → role → website →
 * done`. The qualifyFirst (live-demo) machine is a PostHog-shaped qualifier:
 * `q1 → (q2 only if q1=yes) → q3 → q4 → (result | offer) → form → done`. The
 * two machines share `form`/`done` but never overlap on the qualifier steps,
 * so the default machine is untouched by the qualifier rework.
 */
type Step =
  | "intent"
  | "role"
  | "provider"
  | "website"
  | "q1"
  | "q2"
  | "q3"
  | "q4"
  | "result"
  | "offer"
  | "form"
  | "done";

/** The four qualifier questions, in answer order. Used for the back stack. */
type QualifierStep = "q1" | "q2" | "q3" | "q4";

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
   * Live-demo order: ask a PostHog-shaped qualifier FIRST (Are you on PostHog?
   * → how deep? → lifecycle email today? → what are you building?), captured
   * anonymously under the PostHog distinct_id, show a tailored result segment
   * (or, for non-PostHog visitors, a retainer offer), then the email step last.
   * The post-subscribe identify() stitches those earlier anonymous events to
   * the now-known contact, and the answers are flushed to /api/profile as
   * contact properties. Off (default) keeps the email-first order with the
   * seat/website follow-ups after signup.
   */
  qualifyFirst?: boolean;
};

/**
 * The qualification answers. Values are the closed sets /api/profile accepts;
 * labels are what the visitor sees. ROLE/INTENT/PROVIDER back the default
 * footer/referral flow and stay byte-for-byte — the qualifier flow uses the
 * five new arrays below ALONGSIDE them, never in place of them.
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

/** Q1 — closed set mirrors /api/profile `posthog_usage`. */
const POSTHOG_USAGE_OPTIONS = [
  { value: "yes", label: "Yes, we're on PostHog" },
  { value: "evaluating", label: "Evaluating it" },
  { value: "not_yet", label: "Not yet" },
] as const;

/** Q2 — closed set mirrors /api/profile `posthog_depth` (shown only if Q1=yes). */
const POSTHOG_DEPTH_OPTIONS = [
  { value: "events_dashboards", label: "Events and dashboards" },
  { value: "funnels_cohorts", label: "Funnels and cohorts" },
  { value: "most_of_platform", label: "Most of the platform" },
  { value: "live_in_it", label: "We live in it" },
] as const;

/** Q3 — closed set mirrors /api/profile `lifecycle`. */
const LIFECYCLE_OPTIONS = [
  { value: "not_yet", label: "Not yet" },
  { value: "few_one_offs", label: "A few one-offs" },
  { value: "another_tool", label: "Another tool (Loops, Customer.io…)" },
  { value: "hand_rolled", label: "Hand-rolled in code" },
] as const;

/** Q4 — closed set mirrors /api/profile `building`. */
const BUILDING_OPTIONS = [
  { value: "b2b_saas", label: "B2B SaaS" },
  { value: "consumer_app", label: "Consumer app" },
  { value: "ecommerce", label: "Ecommerce" },
  { value: "agency_clients", label: "Agency / client work" },
  { value: "other", label: "Something else" },
] as const;

/** Non-PostHog offer — closed set mirrors /api/profile `setup_interest`. */
const SETUP_INTEREST_OPTIONS = [
  { value: "yes", label: "Yes, tell me more" },
  { value: "maybe_later", label: "Maybe later" },
  { value: "just_looking", label: "Just looking" },
] as const;

/**
 * Result segments (final copy). The selector evaluates the AGENCY OVERRIDE
 * first, then the PostHog-usage × lifecycle rules below in order; first match
 * wins. `id` is for keys only.
 */
type ResultSegment = {
  id: string;
  headline: string;
  body: string;
  ctas: { label: string; href: string }[];
};

const AGENCY_CLIENT_WORK: ResultSegment = {
  id: "agency_client_work",
  headline: "One instance per client, no per-contact bill",
  body: "Hogsend is self-hosted under ELv2, so each client runs their own instance with journeys you keep in code. If you'd rather hand off the setup, I run a setup week and a monthly retainer.",
  ctas: [
    { label: "See pricing", href: "/pricing" },
    { label: "Read the docs", href: "/docs" },
    { label: "Get it set up", href: "/pricing" },
  ],
};

const POSTHOG_DEEP_NO_LIFECYCLE: ResultSegment = {
  id: "posthog_deep_no_lifecycle",
  headline: "You have the events. You don't have the emails yet.",
  body: "Hogsend reads your PostHog events as journey triggers and sends through Resend, with the journeys defined as TypeScript in your repo. The welcome email you're about to get was sent by the same engine you'd run.",
  ctas: [
    { label: "Watch it run", href: "#live-demo" },
    { label: "Read the journeys guide", href: "/docs/journeys" },
    { label: "Deploy on Railway", href: "/deploy" },
  ],
};

const POSTHOG_ANOTHER_TOOL: ResultSegment = {
  id: "posthog_another_tool",
  headline: "Lifecycle email that lives in your repo, not a dashboard",
  body: "Your journeys become TypeScript you can read, diff, and review, triggered by PostHog events and sent through Resend. Self-hosted under ELv2, with no per-contact billing.",
  ctas: [
    { label: "See the migration guide", href: "/docs/migrate" },
    { label: "Watch it run", href: "#live-demo" },
    { label: "Read the docs", href: "/docs" },
  ],
};

const POSTHOG_HAND_ROLLED: ResultSegment = {
  id: "posthog_hand_rolled",
  headline: "Keep writing it in code. Stop maintaining the plumbing.",
  body: "defineJourney() gives you durable sleeps that survive deploys, first-party open and click tracking, and PostHog event triggers, so a three-day wait is one line instead of a cron and a state table.",
  ctas: [
    { label: "Read the journeys guide", href: "/docs/journeys" },
    { label: "Watch it run", href: "#live-demo" },
    { label: "Read the tracking docs", href: "/docs/tracking" },
  ],
};

const POSTHOG_SHALLOW_OR_FEW_OFFS: ResultSegment = {
  id: "posthog_shallow_or_few_offs",
  headline: "PostHog and Resend already talk. Hogsend is the part in between.",
  body: "Hogsend turns the events you track into triggered email journeys, defined in code and sent through Resend. Start with one welcome series and grow it from there.",
  ctas: [
    { label: "Watch it run", href: "#live-demo" },
    { label: "Read the docs", href: "/docs" },
    { label: "Browse the recipes", href: "/recipes" },
  ],
};

const EVALUATING_POSTHOG: ResultSegment = {
  id: "evaluating_posthog",
  headline: "Worth knowing before you commit to PostHog",
  body: "Hogsend is the lifecycle-email layer for teams on PostHog and Resend, so the events you'd track become triggered journeys defined in code. The demo email you just got shows the loop end to end.",
  ctas: [
    { label: "Read why PostHog", href: "/docs/why-posthog" },
    { label: "Watch it run", href: "#live-demo" },
    { label: "Read the docs", href: "/docs" },
  ],
};

/**
 * selectResult — the result-segment selector for PostHog/evaluating visitors
 * (non-PostHog visitors get the offer instead, never this). Precedence:
 *   1. AGENCY OVERRIDE — building=agency_clients AND posthog_usage ≠ not_yet
 *      shows the agency segment INSTEAD of the PostHog-usage segment.
 *   2. posthog_usage=yes rules, in order (first match wins).
 *   3. posthog_usage=evaluating → the evaluating segment.
 * Returns a stable fallback (the catch-all) so there is always a result.
 */
function selectResult(answers: {
  posthog_usage?: string;
  posthog_depth?: string;
  lifecycle?: string;
  building?: string;
}): ResultSegment {
  const { posthog_usage, posthog_depth, lifecycle, building } = answers;

  // 1. Agency override — wins over the PostHog-usage segment whenever the
  //    visitor builds for clients and is on/evaluating PostHog.
  if (building === "agency_clients" && posthog_usage !== "not_yet") {
    return AGENCY_CLIENT_WORK;
  }

  // 2. Using PostHog — depth × lifecycle rules in order.
  if (posthog_usage === "yes") {
    const deep =
      posthog_depth === "most_of_platform" || posthog_depth === "live_in_it";
    if (deep && lifecycle === "not_yet") {
      return POSTHOG_DEEP_NO_LIFECYCLE;
    }
    if (lifecycle === "another_tool") {
      return POSTHOG_ANOTHER_TOOL;
    }
    if (lifecycle === "hand_rolled") {
      return POSTHOG_HAND_ROLLED;
    }
    // Catch-all for using-PostHog rows not matched above.
    return POSTHOG_SHALLOW_OR_FEW_OFFS;
  }

  // 3. Evaluating PostHog (and any remaining case).
  return EVALUATING_POSTHOG;
}

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

const BACK_CLASS = cn(
  "inline-flex items-center gap-1 rounded-[4px] px-2 py-1 text-white/60",
  "text-xs transition-colors hover:text-white/80",
  FOCUS_RING,
);

const STEP_COUNT_CLASS = "text-white/50 text-xs tracking-[0.08em]";

const RESULT_CTA_PRIMARY = cn(
  "group inline-flex h-11 select-none items-center justify-center gap-2",
  "rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-sm",
  "tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90",
  FOCUS_RING,
);

const RESULT_CTA_SECONDARY = cn(
  "inline-flex h-11 select-none items-center justify-center rounded-[10px]",
  "border border-white/[0.12] bg-white/[0.02] px-4 text-sm text-white/80",
  "transition-colors duration-200 hover:border-white/20 hover:text-white",
  FOCUS_RING,
);

/**
 * EmailCapture — multistep capture with two orders. Default (footer/referral):
 * the first-name + email form first (posting to /api/subscribe, which forwards
 * to the Hogsend ingest API server-side, so the subscription lands no matter
 * what happens after), then the seat + website follow-ups posting to
 * /api/profile. With `qualifyFirst` (the live demo): a PostHog-shaped qualifier
 * runs first (captured anonymously), then a tailored result segment or a
 * retainer offer, then the email form last, and the answers are flushed to
 * /api/profile once the email is known. Input styling matches the ds dark
 * fields; the button mirrors the ds primary Button.
 */
export function EmailCapture({
  className,
  heading = "Get the changelog",
  sub = "One email when something ships, and nothing in between.",
  hideHeading = false,
  placement = "footer",
  qualifyFirst = false,
}: EmailCaptureProps): JSX.Element {
  const [step, setStep] = useState<Step>(qualifyFirst ? "q1" : "form");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [website, setWebsite] = useState("");
  // Qualifier answers (qualifyFirst only). Undefined = unanswered/skipped and
  // never written to the profile.
  const [posthogUsage, setPosthogUsage] = useState<string | undefined>();
  const [posthogDepth, setPosthogDepth] = useState<string | undefined>();
  const [lifecycle, setLifecycle] = useState<string | undefined>();
  const [building, setBuilding] = useState<string | undefined>();
  const [setupInterest, setSetupInterest] = useState<string | undefined>();
  // Back stack of answered qualifier steps (qualifyFirst only). The top is the
  // step Back returns to; restoring its selection is left to the visitor's
  // next answer (Back fires no analytics).
  const [backStack, setBackStack] = useState<QualifierStep[]>([]);
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
    posthog_usage?: string;
    posthog_depth?: string;
    lifecycle?: string;
    building?: string;
    setup_interest?: string;
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
    const normalizedEmail = email.trim().toLowerCase();
    // MF-8 step (1): read the anon distinct id ONCE, before any set_config can
    // rotate it. The same value is sent as `anonymousId` (step 2) and reused
    // as the identify target (step 4) so the post-consent self-alias holds.
    const distinctId = getDistinctId();

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(trimmedName ? { firstName: trimmedName } : {}),
          // Step (2): forwarded as the top-level `anonymousId` (the engine keys
          // the contact on it → returned contactKey equals this browser id).
          ...(distinctId ? { posthogDistinctId: distinctId } : {}),
          termsAccepted,
          productNotes,
        }),
      });
      if (res.ok) {
        // Session identity (in-memory only) lets later deploy clicks in this
        // browsing session reach the docs-subscriber journey via
        // /api/deploy-clicked.
        sessionIdentity.email = normalizedEmail;
        // The required terms checkbox gates submission, so explicit consent is
        // present. Upgrade persistence to durable localStorage+cookie and
        // identify under the canonical Hogsend key (a stable opaque id — the
        // same PostHog person the contact's email events land on). With
        // anonymousId threading contactKey === the browser id, so this is a
        // self-alias carrying only the consented email/name person properties;
        // MF-8 steps (3)+(4) are applied together in grantConsent, using the
        // pre-upgrade `distinctId` as the upgrade anchor.
        const { contactKey } = (await res.json().catch(() => ({}))) as {
          contactKey?: string;
        };
        // Prefer the returned canonical key (covers the existing-contact case
        // where it may differ from the browser id); fall back to the captured
        // anon id so the durable upgrade still anchors on a stable value.
        const identifyTarget = contactKey ?? distinctId;
        if (identifyTarget) {
          grantConsent(identifyTarget, {
            email: normalizedEmail,
            ...(trimmedName ? { name: trimmedName } : {}),
          });
        }
        capture(AnalyticsEvent.CAPTURE_SUBMITTED, {
          placement,
          product_notes: productNotes,
        });
        setStatus("idle");
        if (qualifyFirst) {
          // Flush the qualifier answers gathered before the email as contact
          // properties, mirroring the post-signup steps' /api/profile writes.
          // Skipped/unanswered questions stay undefined and are omitted. When
          // setup_interest is "yes" the /api/profile route fires the dedicated
          // docs.setup.interested event server-side (the lead alert).
          const profileFields = {
            ...(posthogUsage ? { posthog_usage: posthogUsage } : {}),
            ...(posthogDepth ? { posthog_depth: posthogDepth } : {}),
            ...(lifecycle ? { lifecycle } : {}),
            ...(building ? { building } : {}),
            ...(setupInterest ? { setup_interest: setupInterest } : {}),
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

  // Default (footer/referral) flow only — the post-signup seat step. The
  // qualifyFirst flow never reaches `role`, so this posts immediately on the
  // known email and advances to the website step (machine unchanged).
  function handleRole(role: string) {
    capture(AnalyticsEvent.ROLE_SELECTED, { role, placement });
    postProfile({ role });
    setStep("website");
  }

  // The intent + provider steps and their option arrays back the legacy
  // qualifyFirst opener; the new PostHog qualifier supersedes them, but they
  // stay wired (INTENT_OPTIONS/PROVIDER_OPTIONS are kept byte-for-byte) and the
  // INTENT_SELECTED/PROVIDER_SELECTED events stay defined for that path.
  function handleIntent(intent: string) {
    capture(AnalyticsEvent.INTENT_SELECTED, { intent, placement });
    setStep("role");
  }

  function handleProvider(provider: string) {
    capture(AnalyticsEvent.PROVIDER_SELECTED, { provider, placement });
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

  // ── Qualifier (qualifyFirst only) ──────────────────────────────────────────
  // Each answer fires ONE event (docs.qualifier_selected) with the question and
  // closed value, records the answer in state, pushes the step onto the back
  // stack, and advances. Skip advances with no event and leaves the field
  // undefined. Back pops the stack and fires no event.

  /** The destination after Q1: skip Q2 unless the visitor is on PostHog. */
  function afterQ1(usage: string | undefined): Step {
    return usage === "yes" ? "q2" : "q3";
  }

  /** The result/offer landing once Q4 (or its skip) is past. */
  function afterQuestions(usage: string | undefined): Step {
    return usage === "not_yet" ? "offer" : "result";
  }

  function handleQualifier(question: string, answer: string) {
    capture(AnalyticsEvent.QUALIFIER_SELECTED, { question, answer, placement });
    switch (question) {
      case "posthog_usage": {
        setPosthogUsage(answer);
        // Changing the Q1 answer can invalidate a previously-given Q2 depth.
        if (answer !== "yes") setPosthogDepth(undefined);
        setBackStack(["q1"]);
        setStep(afterQ1(answer));
        return;
      }
      case "posthog_depth": {
        setPosthogDepth(answer);
        setBackStack((stack) => [...stack, "q2"]);
        setStep("q3");
        return;
      }
      case "lifecycle": {
        setLifecycle(answer);
        setBackStack((stack) => [...stack, "q3"]);
        setStep("q4");
        return;
      }
      case "building": {
        setBuilding(answer);
        setBackStack((stack) => [...stack, "q4"]);
        setStep(afterQuestions(posthogUsage));
        return;
      }
    }
  }

  /** Skip — advance with no analytics, leaving the field undefined. */
  function skipQualifier(question: string) {
    switch (question) {
      case "posthog_usage": {
        setBackStack(["q1"]);
        setStep(afterQ1(posthogUsage));
        return;
      }
      case "posthog_depth": {
        setBackStack((stack) => [...stack, "q2"]);
        setStep("q3");
        return;
      }
      case "lifecycle": {
        setBackStack((stack) => [...stack, "q3"]);
        setStep("q4");
        return;
      }
      case "building": {
        setBackStack((stack) => [...stack, "q4"]);
        setStep(afterQuestions(posthogUsage));
        return;
      }
    }
  }

  /** Back — pop the stack, return to the previous question, fire no analytics. */
  function goBack() {
    setBackStack((stack) => {
      const next = [...stack];
      const target = next.pop();
      if (target) setStep(target);
      return next;
    });
  }

  /** The non-PostHog offer answer. setup_interest=yes is a lead. */
  function handleOffer(value: string) {
    capture(AnalyticsEvent.QUALIFIER_SELECTED, {
      question: "setup_interest",
      answer: value,
      placement,
    });
    setSetupInterest(value);
    setStep("form");
  }

  // Back is available once at least one question has been answered (q1 always
  // seeds the stack). The offer/result land with the stack non-empty, so Back
  // there returns to Q4.
  const canGoBack = backStack.length > 0;

  const result = selectResult({
    posthog_usage: posthogUsage,
    posthog_depth: posthogDepth,
    lifecycle,
    building,
  });

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

      {step === "q1" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Question 1: Are you using PostHog?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            1 / 4
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            Are you using PostHog?
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {POSTHOG_USAGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleQualifier("posthog_usage", option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => skipQualifier("posthog_usage")}
            className={SKIP_CLASS}
          >
            Skip
          </button>
        </fieldset>
      ) : null}

      {step === "q2" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Question 2: How deep is your PostHog use?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            2 / 4
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            How deep is your PostHog use?
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {POSTHOG_DEPTH_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleQualifier("posthog_depth", option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {canGoBack ? (
              <button type="button" onClick={goBack} className={BACK_CLASS}>
                <ArrowLeft
                  aria-hidden="true"
                  className="size-3"
                  strokeWidth={2}
                />
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => skipQualifier("posthog_depth")}
              className={SKIP_CLASS}
            >
              Skip
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === "q3" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Question 3: How do you send lifecycle email today?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            {posthogUsage === "yes" ? "3 / 4" : "2 / 3"}
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            How do you send lifecycle email today?
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {LIFECYCLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleQualifier("lifecycle", option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {canGoBack ? (
              <button type="button" onClick={goBack} className={BACK_CLASS}>
                <ArrowLeft
                  aria-hidden="true"
                  className="size-3"
                  strokeWidth={2}
                />
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => skipQualifier("lifecycle")}
              className={SKIP_CLASS}
            >
              Skip
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === "q4" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Question 4: What are you building?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p aria-hidden="true" className={STEP_COUNT_CLASS}>
            {posthogUsage === "yes" ? "4 / 4" : "3 / 3"}
          </p>
          <p className="font-medium text-base text-white tracking-[-0.02em]">
            What are you building?
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {BUILDING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleQualifier("building", option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            {canGoBack ? (
              <button type="button" onClick={goBack} className={BACK_CLASS}>
                <ArrowLeft
                  aria-hidden="true"
                  className="size-3"
                  strokeWidth={2}
                />
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => skipQualifier("building")}
              className={SKIP_CLASS}
            >
              Skip
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === "result" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label={result.headline}
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p className="font-medium text-lg text-white leading-6 tracking-[-0.02em]">
            {result.headline}
          </p>
          <p className="max-w-md text-sm text-white/60 leading-5">
            {result.body}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {result.ctas.map((cta, i) => (
              <Link
                key={cta.label}
                href={cta.href}
                className={i === 0 ? RESULT_CTA_PRIMARY : RESULT_CTA_SECONDARY}
              >
                <span>{cta.label}</span>
                {i === 0 ? (
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    strokeWidth={2}
                  />
                ) : null}
              </Link>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep("form")}
            className={cn(SKIP_CLASS, "mt-1")}
          >
            See it live — get the demo email
          </button>
        </fieldset>
      ) : null}

      {step === "offer" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="Want me to set it up for you?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
          <p className="font-medium text-lg text-white leading-6 tracking-[-0.02em]">
            Want me to set it up for you?
          </p>
          <p className="max-w-md text-sm text-white/60 leading-5">
            Hogsend is built for teams on PostHog and Resend, so it&apos;s a fit
            once that stack is in place. If you&apos;d rather not wire it
            yourself, I set teams up as part of a monthly retainer: a setup week
            to get the stack and your first journeys live, then ongoing work on
            the lifecycle. Pick &quot;Yes, tell me more&quot; and it emails
            doug@withseismic.com to start a conversation. No commitment, no
            pricing surprises in the inbox.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {SETUP_INTEREST_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleOffer(option.value)}
                className={CHIP_CLASS}
              >
                {option.label}
              </button>
            ))}
          </div>
          {canGoBack ? (
            <button type="button" onClick={goBack} className={BACK_CLASS}>
              <ArrowLeft
                aria-hidden="true"
                className="size-3"
                strokeWidth={2}
              />
              Back
            </button>
          ) : null}
        </fieldset>
      ) : null}

      {step === "role" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="What's your seat?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
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
        </fieldset>
      ) : null}

      {step === "provider" ? (
        <fieldset
          ref={groupRef}
          tabIndex={-1}
          aria-label="What are you sending email with?"
          className={cn(PANEL_CLASS, !hideHeading && "mt-4")}
        >
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
