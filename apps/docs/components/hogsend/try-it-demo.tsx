"use client";

import { useHogsend, useHogsendFeed } from "@hogsend/react";
import { ArrowRight, Bell, Check, Copy } from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import {
  AnalyticsEvent,
  getDistinctId,
  grantConsent,
  sessionIdentity,
  capture as trackEvent,
} from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL } from "@/lib/site";
import { isHogsendConfigured } from "./config";

/** localStorage keys — `hs-demo-name` is also read by the site banner greeting,
 * so keep writing it. `hs-demo-email` doubles as the "already signed up" flag. */
const NAME_KEY = "hs-demo-name";
const EMAIL_KEY = "hs-demo-email";

/**
 * The three demo actions. `event` MUST match a registered demo journey trigger
 * (apps/api/src/journeys/demo-inapp.ts → DemoEvents.*).
 */
const ACTIONS = [
  {
    event: "demo.welcome",
    label: "Send me a welcome",
    hint: "personalized with your name",
  },
  {
    event: "demo.launch_announcement",
    label: "Send a launch announcement",
    hint: "broadcast-style item with a link",
  },
  {
    event: "demo.trial_ending",
    label: "Send a trial-ending nudge",
    hint: "lifecycle nudge with a CTA",
  },
  {
    event: "demo.survey",
    label: "Send me a survey",
    hint: "an in-app NPS card you answer in the bell",
  },
] as const;

const STEPS = [
  "You fired a first-party event (source: inapp) keyed to your id.",
  "The engine resolved your id to a canonical contact key and routed it.",
  "A journey triggered on that event, read your name, and called sendFeedItem.",
  "It landed in your bell ↗ — open it. Clicking the item fires inapp.item_clicked (and a link.clicked on its tracked CTA) back into the loop.",
] as const;

/** Shared field styling — matches the surrounding Card zones (compact h-10). */
const FIELD_CLASS =
  "h-10 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-white transition-colors placeholder:text-white/30 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

function GatedFallback() {
  return (
    <Card className="my-8 p-6">
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker block">Live demo</span>
        <PillBadge>
          <Bell className="size-3.5" strokeWidth={1.5} />
          Offline here
        </PillBadge>
      </div>
      <p className="text-sm text-white/55 leading-6">
        The live demo is dormant on this build — no engine is wired in.
      </p>
      <p className="mt-2 text-[13px] text-white/40 leading-6">
        Set{" "}
        <code className="font-mono text-white/60">
          NEXT_PUBLIC_HOGSEND_API_URL
        </code>{" "}
        and a <code className="font-mono text-white/60">pk_</code> publishable
        key whose{" "}
        <code className="font-mono text-white/60">allowed_origins</code>{" "}
        includes this site, and the buttons go live.
      </p>
    </Card>
  );
}

export function TryItDemo({ codePanel }: { codePanel?: ReactNode }) {
  if (!isHogsendConfigured) return <GatedFallback />;
  return <TryItDemoLive codePanel={codePanel} />;
}

function TryItDemoLive({ codePanel }: { codePanel?: ReactNode }) {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [signedUp, setSignedUp] = useState(false);
  const [anonId, setAnonId] = useState("");
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Move focus across the form ↔ identified swap so keyboard / SR users keep
  // their place. Driven by an explicit request set in submit/reset (NOT a
  // `signedUp` effect), so the hydrate restore of a return visitor never steals
  // focus on load.
  const identifiedRef = useRef<HTMLParagraphElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const pendingFocus = useRef<"identified" | "form" | null>(null);
  useEffect(() => {
    if (pendingFocus.current === "identified") identifiedRef.current?.focus();
    else if (pendingFocus.current === "form") emailRef.current?.focus();
    pendingFocus.current = null;
  });

  // Hydrate display-only + persisted values client-side (avoids SSR mismatch;
  // localStorage is read only in the browser). A return visitor who already
  // signed up is restored straight to the identified state with the buttons
  // live; name pre-fills regardless.
  useEffect(() => {
    setAnonId(client.getDistinctId());
    try {
      const savedName = window.localStorage.getItem(NAME_KEY);
      if (savedName) setName(savedName);
      const savedEmail = window.localStorage.getItem(EMAIL_KEY);
      if (savedEmail) {
        setEmail(savedEmail);
        setConsent(true);
        setSignedUp(true);
      }
    } catch {
      // Private mode / storage blocked — start fresh, no pre-fill.
    }
  }, [client]);

  // In-session state only while typing: the name is PII, so it reaches
  // localStorage exclusively at signup (submitSignup below), where the
  // consent checkbox rides the same submit.
  function onName(value: string) {
    setName(value);
  }

  function copyAnon() {
    if (!anonId) return;
    navigator.clipboard
      ?.writeText(anonId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        // Clipboard denied / insecure context — non-fatal, no UI change.
      });
  }

  // The sign-up: a CONSENTED identify, done entirely client-side. We do NOT
  // POST the email to the engine here — a `pk_` publishable key is structurally
  // anon-only (the engine 403s any asserted email/userId without a server-minted
  // userToken), and the server-side subscribe path would fire a real welcome
  // email. Instead we record the consented person on PostHog (email + name as
  // $set person properties under the stable distinct id) and persist locally.
  // The in-app feed stays keyed to the same anon id, so the bell keeps working.
  // NB: the consented email lives in PostHog (analytics) only, NOT the engine
  // contact — this is an analytics identify + a UX gate, not engine identity.
  function submitSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signedUp) return;
    const normalizedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    // Native `required` + type="email" gate the form; re-check defensively.
    if (!normalizedEmail || !consent) return;

    // Read the PostHog anon id ONCE before grantConsent can rotate it, then
    // identify under it with the consented person properties — a self-alias
    // that only attaches email/name (no merge, no email send). No-ops cleanly
    // when analytics is off, so the demo still unlocks.
    const distinctId = getDistinctId();
    if (distinctId) {
      grantConsent(distinctId, {
        email: normalizedEmail,
        ...(trimmedName ? { name: trimmedName } : {}),
      });
    }
    sessionIdentity.email = normalizedEmail;
    trackEvent(AnalyticsEvent.CAPTURE_SUBMITTED, { placement: "live-demo" });

    try {
      window.localStorage.setItem(EMAIL_KEY, normalizedEmail);
      if (trimmedName) window.localStorage.setItem(NAME_KEY, trimmedName);
    } catch {
      // Best-effort persistence — the identify still holds for this session.
    }
    pendingFocus.current = "identified";
    setSignedUp(true);
  }

  function resetSignup() {
    pendingFocus.current = "form";
    setSignedUp(false);
    setEmail("");
    setConsent(false);
    try {
      window.localStorage.removeItem(EMAIL_KEY);
    } catch {
      // Best-effort.
    }
  }

  async function fire(event: string) {
    if (!signedUp || firing !== null) return;
    setFiring(event);
    setStep(0);
    try {
      // 1) capture the first-party event, carrying the name as a property
      await capture(event, name ? { name } : {});
      setStep(1);
      // 2) flush so it hits the engine immediately (capture is batched)
      await client.flush();
      setStep(2);
      // 3) give the journey a beat to insert the feed item, then refetch so the
      //    bell badge updates instantly (the poll backstops it regardless)
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      setStep(3);
      await refetch();
    } catch {
      // A transient network failure must not brick the demo — reset the
      // narration and re-enable the buttons via `finally`.
      setStep(-1);
    } finally {
      setFiring(null);
    }
  }

  return (
    <div className="relative my-8 not-prose">
      {/* red atmospheric bloom (the CodeWindow idiom) */}
      <div
        aria-hidden="true"
        className="-inset-x-12 -top-10 pointer-events-none absolute h-48"
        style={{
          background:
            "radial-gradient(55% 55% at 50% 0%, rgba(246,72,56,0.12), transparent 70%)",
          filter: "blur(40px)",
        }}
      />

      <div className="relative grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* ── LEFT: the interactive panel ── */}
        <Card className="flex flex-col p-0">
          {/* zone 1 — header */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="kicker block">Live demo</span>
              <PillBadge>
                <Bell className="size-3.5" strokeWidth={1.5} />
                {signedUp ? "Signed up — fire away" : "Sign up, then fire it"}
              </PillBadge>
            </div>
            <h3 className="font-display text-white text-2xl tracking-[-0.02em]">
              Fire it. Watch your bell.
            </h3>
            <p className="mt-1.5 text-sm text-white/55 leading-6">
              Sign up below, then fire a real lifecycle event. A journey turns
              it into a notification in the bell ↗ in the top nav — your feed
              stays anonymous, this session.
            </p>
          </div>

          {/* zone 2 — sign-up gate (identity) */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={copyAnon}
                className="group inline-flex min-w-0 items-center gap-2 font-mono text-[11px] text-white/40 tracking-wide transition-colors hover:text-white/70"
                title="Copy your anonymous id"
              >
                <span className="truncate">
                  {anonId ? `anon: ${anonId}` : "anon: …"}
                </span>
                {copied ? (
                  <Check className="size-3 shrink-0 text-good" />
                ) : (
                  <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                )}
              </button>
              <TagPill accent={signedUp}>
                {signedUp ? "signed up" : "not signed up"}
              </TagPill>
            </div>

            {signedUp ? (
              <div className="mt-4" role="status" aria-live="polite">
                <p
                  ref={identifiedRef}
                  tabIndex={-1}
                  className="text-[13px] text-white/70 leading-6 outline-none"
                >
                  Signed up as{" "}
                  <span className="font-medium text-white">{email}</span>. The
                  buttons below now fire real lifecycle journeys onto your feed.
                </p>
                <p className="mt-3 text-[12px] text-white/40 leading-5">
                  The same identity graph reaches across channels: when a{" "}
                  <span className="text-white/60">known</span> user runs{" "}
                  <code className="font-mono text-white/70">/link</code> in the{" "}
                  <a
                    href={DISCORD_INVITE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2 transition-colors hover:text-accent/80"
                  >
                    Hogsend Discord
                  </a>
                  , a “You linked your Discord” item lands in their in-app bell
                  — one identity, web and Discord.
                </p>
                <button
                  type="button"
                  onClick={resetSignup}
                  className="mt-3 text-[12px] text-white/35 underline underline-offset-2 transition-colors hover:text-white/60"
                >
                  Use a different email
                </button>
              </div>
            ) : (
              <form
                onSubmit={submitSignup}
                className="mt-4 flex flex-col gap-3"
              >
                <div>
                  <label
                    htmlFor="hs-demo-name"
                    className="block text-[13px] text-white/50"
                  >
                    Your name{" "}
                    <span className="text-white/30">
                      (optional — personalizes the item)
                    </span>
                  </label>
                  <input
                    id="hs-demo-name"
                    type="text"
                    value={name}
                    onChange={(e) => onName(e.target.value)}
                    placeholder="e.g. Doug"
                    autoComplete="given-name"
                    maxLength={80}
                    className={cn("mt-1.5", FIELD_CLASS)}
                  />
                </div>

                <div>
                  <label
                    htmlFor="hs-demo-email"
                    className="block text-[13px] text-white/50"
                  >
                    Email{" "}
                    <span className="text-white/30">
                      (for this demo — no email is sent)
                    </span>
                  </label>
                  <input
                    id="hs-demo-email"
                    ref={emailRef}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    className={cn("mt-1.5", FIELD_CLASS)}
                  />
                </div>

                {/* The checkbox's <label> wraps only plain text (no interactive
                    descendants); the legal links sit OUTSIDE it as siblings so
                    each stays an unambiguous, independently-clickable target. */}
                <div className="flex items-start gap-2.5 text-[12px] text-white/50 leading-5">
                  <input
                    id="hs-demo-consent"
                    type="checkbox"
                    required
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 size-3.5 shrink-0 accent-accent"
                  />
                  <span>
                    <label htmlFor="hs-demo-consent" className="cursor-pointer">
                      I agree to identify myself for this demo
                    </label>{" "}
                    under the{" "}
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
                    .
                  </span>
                </div>

                <button
                  type="submit"
                  className="group inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                >
                  Sign up to fire it
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={2}
                  />
                </button>
              </form>
            )}
          </div>

          {/* zone 3 — action row (gated until signed up) */}
          <div className="flex flex-col gap-2 border-white/[0.08] border-b p-6">
            {signedUp ? null : (
              <p className="mb-1 text-[12px] text-white/40 leading-5">
                Sign up above to fire real lifecycle messages.
              </p>
            )}
            {ACTIONS.map((action) => (
              <button
                key={action.event}
                type="button"
                disabled={firing !== null || !signedUp}
                onClick={() => fire(action.event)}
                className={cn(
                  "group inline-flex h-12 items-center justify-between gap-2 rounded-[10px] border px-4 text-left text-sm transition-colors",
                  "border-white/[0.08] bg-white/[0.04] text-white hover:border-white/15 hover:bg-white/[0.06]",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04]",
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{action.label}</span>
                  <span className="truncate font-mono text-[11px] text-white/35">
                    capture("{action.event}"
                    {name ? `, { name: "${name}" }` : ""})
                  </span>
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5"
                  strokeWidth={1.5}
                />
              </button>
            ))}
          </div>

          {/* zone 4 — live narration */}
          <div className="p-6" role="status" aria-live="polite">
            <ol className="flex flex-col gap-2.5">
              {STEPS.map((text, i) => {
                const active = step === i;
                const done = step > i;
                return (
                  <li key={text} className="flex items-start gap-3">
                    <TagPill
                      accent={active || done}
                      className="mt-0.5 size-6 shrink-0 justify-center px-0 tabular-nums"
                    >
                      {done ? <Check className="size-3" /> : i + 1}
                    </TagPill>
                    <span
                      className={cn(
                        "pt-0.5 text-[13px] leading-5 transition-colors",
                        active
                          ? "text-white"
                          : done
                            ? "text-white/60"
                            : "text-white/35",
                      )}
                    >
                      {text}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 text-[12px] text-white/35 leading-5">
              Unread in your bell:{" "}
              <span className="font-mono text-accent tabular-nums">
                {metadata.unread_count ?? 0}
              </span>
              . Each item carries a tracked CTA — clicking the row emits{" "}
              <code className="font-mono text-white/55">
                inapp.item_clicked
              </code>{" "}
              and a{" "}
              <code className="font-mono text-white/55">link.clicked</code>,
              both real first-party events a journey can react to.
            </p>
          </div>
        </Card>

        {/* ── RIGHT: the code that just ran ── */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          {codePanel}
          <p className="mt-3 text-[12px] text-white/40 leading-5">
            This is the journey that drops the notification into your bell. It
            reads your name off the event and personalizes the title — your
            in-app feed stays keyed to one id end to end, so the bell works
            whether or not you signed up.
          </p>
        </div>
      </div>
    </div>
  );
}
