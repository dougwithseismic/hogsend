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
import {
  authClient,
  signIn,
  signOut,
  updateUser,
  useSession,
} from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL } from "@/lib/site";
import { isHogsendConfigured } from "./config";

/** The site banner greeting (components/landing/banner-ticker.tsx) reads this
 * key, so the sign-up keeps writing it. There is no `hs-demo-email` flag any
 * more: the gate below is a real Better Auth session, not a value this browser
 * wrote to itself. */
const NAME_KEY = "hs-demo-name";

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

/** The white CTA shared by the email step and the code step. */
const CTA_CLASS =
  "group inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-60";

type Pending = null | "code" | "resend" | "verify";

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
  const { client, capture, userId, isIdentified } = useHogsend();
  const { refetch: refetchFeed, metadata } = useHogsendFeed();
  // The gate. A signed-in visitor is engine-identified by HogsendDocsProvider
  // (session → /api/hogsend-token → identify + feed token), so "can this
  // person fire the demo" is exactly "is there a session".
  const {
    data: session,
    isPending: sessionPending,
    refetch: refetchSession,
  } = useSession();
  const signedIn = Boolean(session);
  // The session is resolved client-side, so the server has no idea whether
  // anyone is signed in. Rendering the sign-in form on the server and the
  // "checking" placeholder on the client (or vice versa) is a hydration
  // mismatch, which makes React throw the subtree away and re-render it. Pin
  // BOTH the server pass and the first client pass to the placeholder by
  // treating "not yet mounted" as "still checking"; the real branch is picked
  // once the effect below has run and hydration is done.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const checkingSession = !mounted || sessionPending;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);
  const [formStep, setFormStep] = useState<"email" | "code">("email");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [anonId, setAnonId] = useState("");
  const [narration, setNarration] = useState(-1);
  // The engine identity never resolved, so the last fire went out under the
  // browser's anonymous id rather than this account.
  const [unlinked, setUnlinked] = useState(false);
  const [firing, setFiring] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const address = email.trim().toLowerCase();
  // The account name wins over whatever is typed in the (optional) field: a
  // returning visitor never sees the field, and we must not let a stale local
  // value shadow the name the journey will greet them by.
  const accountName = (session?.user.name ?? "").trim();
  const effectiveName = accountName || name.trim();

  // Move focus across the form ↔ signed-in swap so keyboard / SR users keep
  // their place. Driven by an explicit request set in the handlers (NOT a
  // `signedIn` effect), so restoring an already-signed-in visitor on load never
  // steals focus. The request SURVIVES renders where the target isn't mounted
  // yet: the swap is now async (the session atom refetches after verify), so
  // the identified paragraph lands a render or two after the request.
  const identifiedRef = useRef<HTMLParagraphElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const pendingFocus = useRef<"identified" | "form" | "code" | null>(null);
  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    const el =
      want === "identified"
        ? identifiedRef.current
        : want === "form"
          ? emailRef.current
          : codeRef.current;
    if (!el) return;
    el.focus();
    pendingFocus.current = null;
  });

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // Display-only, resolved client-side (avoids an SSR mismatch — the anon id
  // lives in browser storage). `userId` is the reactive identity slice, so
  // signing in swaps the chip from the browser's anon id to the canonical
  // contact key without a remount.
  useEffect(() => {
    setAnonId(userId ?? client.getDistinctId());
  }, [client, userId]);

  useEffect(() => {
    try {
      const savedName = window.localStorage.getItem(NAME_KEY);
      if (savedName) setName(savedName);
    } catch {
      // Private mode / storage blocked — start fresh, no pre-fill.
    }
  }, []);

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

  /**
   * Record the sign-up consent server-side, keyed to the EMAIL — the exact
   * call the /sign-in form makes, deliberately the SAME path rather than a
   * second one. Fired at REQUEST time (before the code is verified) so it is
   * device-independent and never depends on the later feed-token mint.
   * Fire-and-forget so it never delays the code.
   */
  function recordConsent() {
    const typedName = name.trim();
    void fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: address,
        // The route writes this to `contactProperties.firstName`, so the
        // welcome journey can greet by name. Without it the name reaches the
        // contact only via the later token mint, which a visitor who never
        // returns to the page never triggers.
        ...(typedName ? { firstName: typedName } : {}),
        termsAccepted: true,
        productNotes,
      }),
      keepalive: true,
    }).catch(() => {});
  }

  /**
   * better-auth's client returns `{ data, error }` for an HTTP error but
   * REJECTS on a transport failure (offline, DNS, abort) — `betterFetch` awaits
   * `fetch` unwrapped and the client registers no catch-all. An unguarded
   * `await` would therefore leave `pending` set forever, and every control here
   * is disabled on `pending !== null`, so the form would go silently dead with
   * no error and the demo locked. Hence try/catch with the release in `finally`
   * on all three calls that cross the network.
   */
  async function sendCode(mode: "code" | "resend") {
    setPending(mode);
    setError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      });
      if (res.error) {
        setError("Couldn't send the code. Check the address and try again.");
        return;
      }
      setFormStep("code");
      setCode("");
      setCooldown(30);
      pendingFocus.current = "code";
    } catch {
      setError("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setPending(null);
    }
  }

  async function onEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Native `required` + type="email" gate the form; re-check defensively.
    if (!termsAccepted || !address) return;
    recordConsent();
    await sendCode("code");
  }

  /**
   * Verify the code. `emailOTP` runs with `disableSignUp: false`, so a first
   * sign-in CREATES the account — this is the real registration, not a local
   * flag. Everything after the success branch is post-sign-up bookkeeping.
   */
  async function verify(value: string) {
    setPending("verify");
    setError(null);
    let res: Awaited<ReturnType<typeof signIn.emailOtp>>;
    try {
      res = await signIn.emailOtp({ email: address, otp: value });
    } catch {
      setPending(null);
      setError("Couldn't reach the server. Check your connection and retry.");
      return;
    }
    if (res.error) {
      setPending(null);
      setCode("");
      setError("That code didn't match. Check it, or send a new one.");
      return;
    }

    const typedName = name.trim();
    // Only fill a gap: an existing account keeps the name it already has
    // (Better Auth's create hook may already have reused one from Hogsend).
    if (typedName && !(res.data?.user.name ?? "").trim()) {
      await updateUser({ name: typedName }).catch(() => {});
    }
    if (typedName) {
      try {
        window.localStorage.setItem(NAME_KEY, typedName);
      } catch {
        // Best-effort — only the banner greeting depends on it.
      }
    }

    // Consented PostHog identify: read the anon distinct id BEFORE
    // grantConsent can rotate it, then identify under that same id — a
    // self-alias that only attaches email/name. No-ops when analytics is off.
    const distinctId = getDistinctId();
    if (distinctId) {
      grantConsent(distinctId, {
        email: address,
        ...(typedName ? { name: typedName } : {}),
      });
    }
    sessionIdentity.email = address;
    trackEvent(AnalyticsEvent.CAPTURE_SUBMITTED, {
      placement: "live-demo",
      product_notes: productNotes,
    });

    pendingFocus.current = "identified";
    // NO navigation — this demo is embedded mid-page and a reload would
    // destroy it. `signIn.emailOtp` flips better-auth's session signal on a
    // ~10ms timer, so the session is still stale here; refetch to pull the new
    // one into every `useSession()` consumer (this gate AND the provider that
    // mints the feed token) in place.
    // The sign-in already succeeded, so a failure to refresh must not strand
    // the visitor: better-auth's own ~10ms session signal still lands and flips
    // the gate a beat later.
    try {
      await refetchSession();
    } catch {
      // Ignored on purpose — see above.
    } finally {
      setPending(null);
      setCode("");
    }
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && pending === null) {
      void verify(digits);
    }
  }

  /**
   * The gate is a session now, so "use a different email" has to be a real
   * sign-out (it ends the shared `.hogsend.com` session, hence the explicit
   * label). `/sign-out` is on better-auth's own signal matcher, but refetch
   * anyway so the swap back to the form doesn't wait on that timer.
   */
  async function endSession() {
    setPending(null);
    setError(null);
    try {
      await signOut();
      await refetchSession();
    } catch {
      // A dropped sign-out leaves the session alive; say so rather than
      // resetting the form to a state that contradicts it.
      setError("Couldn't sign you out. Check your connection and retry.");
      return;
    }
    setFormStep("email");
    setEmail("");
    setCode("");
    setTermsAccepted(false);
    setProductNotes(false);
    setNarration(-1);
    pendingFocus.current = "form";
  }

  /**
   * The gate opens on the SESSION, but the engine identity lands one
   * `/api/hogsend-token` round trip later. Firing inside that window keys the
   * event — and the feed item the journey publishes off it — to the browser's
   * anonymous id, while the bell re-keys to the contact as soon as the token
   * arrives, so that notification would never show up. `feed_items` are not
   * repointed by an identify the way events and journey state are, so this is
   * a lost message rather than a delayed one.
   *
   * Wait for identity, but never BLOCK the demo on it: when the token endpoint
   * is unconfigured or down, `isIdentified()` never turns true, and firing
   * anonymously still demonstrates the whole loop. Read off `client` rather
   * than the `isIdentified` render slice, which is stale inside this closure.
   */
  async function awaitIdentity(): Promise<boolean> {
    const deadline = Date.now() + 1500;
    while (!client.isIdentified() && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return client.isIdentified();
  }

  async function fire(event: string) {
    if (!signedIn || firing !== null) return;
    setFiring(event);
    setNarration(0);
    setUnlinked(false);
    try {
      // When identity never arrives the event still fires, but under the
      // browser's anonymous id — so it does NOT reach this account's bell. Say
      // so instead of narrating a delivery that did not happen.
      if (!(await awaitIdentity())) setUnlinked(true);
      // 1) capture the first-party event, carrying the name as a property
      await capture(event, effectiveName ? { name: effectiveName } : {});
      setNarration(1);
      // 2) flush so it hits the engine immediately (capture is batched)
      await client.flush();
      setNarration(2);
      // 3) give the journey a beat to insert the feed item, then refetch so the
      //    bell badge updates instantly (the poll backstops it regardless)
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      setNarration(3);
      await refetchFeed();
    } catch {
      // A transient network failure must not brick the demo — reset the
      // narration and re-enable the buttons via `finally`.
      setNarration(-1);
    } finally {
      setFiring(null);
    }
  }

  const canSubmit = pending === null && termsAccepted;
  const idLabel = isIdentified ? "id" : "anon";

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

      <div className="relative grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* ── LEFT: the interactive panel ── */}
        <Card className="flex flex-col p-0">
          {/* zone 1 — header */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="kicker block">Live demo</span>
              <PillBadge>
                <Bell className="size-3.5" strokeWidth={1.5} />
                {signedIn ? "Signed in — fire away" : "Sign in, then fire it"}
              </PillBadge>
            </div>
            <h3 className="font-display text-white text-2xl tracking-[-0.02em]">
              Fire it. Watch your bell.
            </h3>
            <p className="mt-1.5 text-sm text-white/55 leading-6">
              Sign in below. A 6-digit code arrives by email; first time
              through, that creates your account. Then fire a real lifecycle
              event: a journey turns it into a notification in the bell ↗ in the
              top nav, on the contact behind that account.
            </p>
          </div>

          {/* zone 2 — sign-in gate (identity) */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={copyAnon}
                className="group inline-flex min-w-0 items-center gap-2 font-mono text-[11px] text-white/40 tracking-wide transition-colors hover:text-white/70"
                title={
                  isIdentified
                    ? "Copy your contact id"
                    : "Copy your anonymous id"
                }
              >
                <span className="truncate">{`${idLabel}: ${anonId || "…"}`}</span>
                {copied ? (
                  <Check className="size-3 shrink-0 text-good" />
                ) : (
                  <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                )}
              </button>
              <TagPill accent={signedIn}>
                {signedIn ? "signed in" : "not signed in"}
              </TagPill>
            </div>

            {checkingSession ? (
              // FIRST in the chain, so the server pass and the first client
              // pass always agree (see `checkingSession` above).
              <p
                className="mt-4 text-[13px] text-white/40 leading-6"
                role="status"
                aria-live="polite"
              >
                Checking your session…
              </p>
            ) : signedIn ? (
              <div className="mt-4" role="status" aria-live="polite">
                <p
                  ref={identifiedRef}
                  tabIndex={-1}
                  className="text-[13px] text-white/70 leading-6 outline-none"
                >
                  Signed in as{" "}
                  <span className="font-medium text-white">
                    {session?.user.email}
                  </span>
                  . The buttons below now fire real lifecycle journeys onto your
                  feed.
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
                  onClick={endSession}
                  className="mt-3 text-[12px] text-white/35 underline underline-offset-2 transition-colors hover:text-white/60"
                >
                  Sign out and use a different email
                </button>
                {/* `endSession` is the only thing that can fail in this branch,
                    and it returns early on failure — without this the visitor
                    clicks sign out, stays signed in, and is told nothing. */}
                {error ? (
                  <p
                    className="mt-2 text-[12px] text-accent leading-5"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
              </div>
            ) : formStep === "code" ? (
              <div className="mt-4 flex flex-col gap-3">
                <p
                  className="text-[13px] text-white/55 leading-6"
                  role="status"
                  aria-live="polite"
                >
                  We sent a 6-digit code to{" "}
                  <span className="font-medium text-white">{address}</span>.
                  Enter it below.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (code.length === 6) void verify(code);
                  }}
                  className="flex flex-col gap-3"
                >
                  <input
                    ref={codeRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => onCodeChange(e.target.value)}
                    placeholder="000000"
                    aria-label="Sign-in code"
                    className="h-12 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-center font-mono text-white text-xl tracking-[0.4em] transition-colors placeholder:text-white/20 focus:border-accent focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={pending !== null || code.length !== 6}
                    className={CTA_CLASS}
                  >
                    {pending === "verify" ? "Verifying…" : "Verify and sign in"}
                  </button>
                </form>

                {error ? (
                  <p className="text-[12px] text-accent leading-5" role="alert">
                    {error}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-white/40">
                  <button
                    type="button"
                    onClick={() => sendCode("resend")}
                    disabled={pending !== null || cooldown > 0}
                    className="underline underline-offset-2 transition-colors hover:text-white/70 disabled:no-underline disabled:opacity-60"
                  >
                    {cooldown > 0
                      ? `Resend code in ${cooldown}s`
                      : pending === "resend"
                        ? "Sending…"
                        : "Resend code"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFormStep("email");
                      setCode("");
                      setError(null);
                      pendingFocus.current = "form";
                    }}
                    className="underline underline-offset-2 transition-colors hover:text-white/70"
                  >
                    Use a different email
                  </button>
                </div>
              </div>
            ) : (
              <form
                onSubmit={onEmailSubmit}
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
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Doug"
                    autoComplete="given-name"
                    maxLength={80}
                    disabled={pending !== null}
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
                      (we email you a 6-digit code)
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
                    disabled={pending !== null}
                    className={cn("mt-1.5", FIELD_CLASS)}
                  />
                </div>

                {/* Each checkbox's <label> wraps only plain text (no interactive
                    descendants); the legal links sit OUTSIDE it as siblings so
                    each stays an unambiguous, independently-clickable target.
                    `aria-label` carries the full sentence the links interrupt,
                    so the control still announces what it commits you to. */}
                <div className="flex items-start gap-2.5 text-[12px] text-white/50 leading-5">
                  <input
                    id="hs-demo-terms"
                    type="checkbox"
                    required
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    disabled={pending !== null}
                    aria-label="I agree to the terms and privacy policy"
                    className="mt-0.5 size-3.5 shrink-0 accent-accent"
                  />
                  <span>
                    <label htmlFor="hs-demo-terms" className="cursor-pointer">
                      I agree to the
                    </label>{" "}
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
                </div>

                <div className="flex items-start gap-2.5 text-[12px] text-white/50 leading-5">
                  <input
                    id="hs-demo-notes"
                    type="checkbox"
                    checked={productNotes}
                    onChange={(e) => setProductNotes(e.target.checked)}
                    disabled={pending !== null}
                    className="mt-0.5 size-3.5 shrink-0 accent-accent"
                  />
                  <label htmlFor="hs-demo-notes" className="cursor-pointer">
                    Send me product notes when something ships. Optional —
                    unsubscribe is one click either way.
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className={CTA_CLASS}
                >
                  {pending === "code"
                    ? "Sending code…"
                    : "Email me a sign-in code"}
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={2}
                  />
                </button>

                {error ? (
                  <p className="text-[12px] text-accent leading-5" role="alert">
                    {error}
                  </p>
                ) : null}
              </form>
            )}
          </div>

          {/* zone 3 — action row (gated until signed in) */}
          <div className="flex flex-col gap-2 border-white/[0.08] border-b p-6">
            {signedIn ? null : (
              <p className="mb-1 text-[12px] text-white/40 leading-5">
                Sign in above to fire real lifecycle messages.
              </p>
            )}
            {ACTIONS.map((action) => (
              <button
                key={action.event}
                type="button"
                disabled={firing !== null || !signedIn}
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
                    {effectiveName ? `, { name: "${effectiveName}" }` : ""})
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
                const active = narration === i;
                const done = narration > i;
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
            {unlinked ? (
              <p
                className="mt-4 text-[12px] text-accent leading-5"
                role="status"
                aria-live="polite"
              >
                That event fired under this browser's anonymous id, not your
                account: the engine identity never resolved, so it will not
                reach your bell. Reload the page to retry the link.
              </p>
            ) : null}
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
            reads your name off the event and personalizes the title — it lands
            on the contact behind your account, the same one the bell reads, so
            the item is waiting for you on any device you sign in from.
          </p>
        </div>
      </div>
    </div>
  );
}
