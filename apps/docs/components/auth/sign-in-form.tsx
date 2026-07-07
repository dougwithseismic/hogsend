"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { authClient, signIn } from "@/lib/auth-client";
import { safeInternalPath } from "@/lib/safe-next";

type Pending = null | "code" | "verify" | "magic" | "github" | "resend";

/**
 * Passwordless SIGN-UP / sign-in for the docs site (one account across
 * hogsend.com + course.hogsend.com). Primary path is a 6-digit email code the
 * visitor types on this same tab; magic link + GitHub are fallbacks.
 *
 * It doubles as the newsletter opt-in: a REQUIRED terms/privacy checkbox gates
 * submission, and an optional "product notes" checkbox subscribes them. The
 * consent choice is dropped in the `hs_su` cookie right before sign-in and
 * recorded once by `/api/hogsend-token` after auth (so every path records it).
 *
 * The first name is asked PROGRESSIVELY — only AFTER sign-in and only when we
 * don't already have one. Better Auth's user-create hook reuses a name we know
 * from Hogsend, and a returning account keeps its name, so most visitors are
 * never asked. `next` is a pre-validated same-site path we navigate to on
 * success (the whole document, so the destination re-renders identified).
 */
export function SignInForm({
  next,
  githubEnabled,
}: {
  next: string;
  githubEnabled: boolean;
}) {
  const [step, setStep] = useState<"email" | "code" | "name">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Move focus to the code field the moment it appears.
  useEffect(() => {
    if (step === "code") codeInputRef.current?.focus();
  }, [step]);

  const target = () => safeInternalPath(next);

  /**
   * Drop the sign-up consent breadcrumb right before initiating auth. Value "1"
   * when they opted into product updates; presence means terms accepted (the UI
   * gates on it). `/api/hogsend-token` reads + clears it after sign-in.
   */
  function dropConsentCookie() {
    // biome-ignore lint/suspicious/noDocumentCookie: a short-lived breadcrumb consumed server-side; the async Cookie Store API is unnecessary here
    document.cookie = `hs_su=${productNotes ? "1" : "0"}; path=/; max-age=1800; samesite=lax`;
  }

  async function sendCode(mode: "code" | "resend") {
    setPending(mode);
    setError(null);
    const res = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setPending(null);
    if (res.error) {
      setError("Couldn't send the code. Check the address and try again.");
      return;
    }
    setStep("code");
    setCode("");
    setCooldown(30);
  }

  async function onEmailSubmit(e: FormEvent) {
    e.preventDefault();
    if (!termsAccepted) return;
    dropConsentCookie();
    await sendCode("code");
  }

  async function verify(value: string) {
    setPending("verify");
    setError(null);
    const res = await signIn.emailOtp({ email, otp: value });
    if (res.error) {
      setPending(null);
      setCode("");
      setError("That code didn't match. Check it, or send a new one.");
      return;
    }
    // Ask for a first name ONLY if we don't already have one (the create hook
    // reuses a name known from Hogsend; a returning account keeps its name).
    if (res.data?.user?.name?.trim()) {
      window.location.assign(target());
      return;
    }
    setPending(null);
    setStep("name");
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && pending === null) {
      void verify(digits);
    }
  }

  async function completeName(e: FormEvent) {
    e.preventDefault();
    setPending("verify");
    const name = firstName.trim();
    if (name) {
      await authClient.updateUser({ name }).catch(() => {});
    }
    window.location.assign(target());
  }

  async function onMagic() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    if (!termsAccepted) {
      setError("Please agree to the terms first.");
      return;
    }
    setPending("magic");
    setError(null);
    dropConsentCookie();
    const res = await signIn.magicLink({ email, callbackURL: target() });
    setPending(null);
    if (res.error) {
      setError("Couldn't send the link. Check the address and try again.");
    } else {
      setMagicSent(true);
    }
  }

  async function onGithub() {
    if (!termsAccepted) {
      setError("Please agree to the terms first.");
      return;
    }
    setPending("github");
    setError(null);
    dropConsentCookie();
    await signIn.social({ provider: "github", callbackURL: target() });
  }

  // Magic-link fallback confirmation.
  if (magicSent) {
    return (
      <div className="rounded-md border border-white/[0.08] bg-white/[0.015] p-6">
        <p className="font-display text-xl tracking-[-0.02em] text-white">
          Check your inbox
        </p>
        <p className="mt-2 text-sm text-white/60 leading-6">
          We sent a sign-in link to <span className="text-white">{email}</span>.
          It's single-use and expires in 15 minutes.
        </p>
        <button
          type="button"
          onClick={() => setMagicSent(false)}
          className="mt-4 text-sm text-white/50 underline transition-colors hover:text-white"
        >
          Use a different way to sign in
        </button>
      </div>
    );
  }

  // Post-sign-in: ask for a first name we don't yet have.
  if (step === "name") {
    return (
      <form onSubmit={completeName} className="flex flex-col gap-3">
        <p className="text-sm text-white/60 leading-6">
          You're in. What should we call you?
        </p>
        <input
          // biome-ignore lint/a11y/noAutofocus: single field on a dedicated step
          autoFocus
          type="text"
          required
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="First name"
          aria-label="First name"
          className="h-12 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/30"
        />
        <button
          type="submit"
          disabled={pending !== null || firstName.trim().length === 0}
          className="h-12 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {pending === "verify" ? "Finishing…" : "Continue"}
        </button>
      </form>
    );
  }

  // Code-entry step.
  if (step === "code") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-white/60 leading-6">
          We sent a 6-digit code to <span className="text-white">{email}</span>.
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
            ref={codeInputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            placeholder="000000"
            aria-label="Sign-in code"
            className="h-14 rounded-[10px] border border-white/[0.12] bg-white/[0.03] text-center font-mono text-2xl text-white tracking-[0.5em] outline-none transition-colors placeholder:text-white/20 focus:border-white/30"
          />
          <button
            type="submit"
            disabled={pending !== null || code.length !== 6}
            className="h-12 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:opacity-60"
          >
            {pending === "verify" ? "Verifying…" : "Verify and sign in"}
          </button>
        </form>

        {error ? <p className="text-sm text-accent">{error}</p> : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-white/50">
          <button
            type="button"
            onClick={() => sendCode("resend")}
            disabled={pending !== null || cooldown > 0}
            className="underline transition-colors hover:text-white disabled:no-underline disabled:opacity-60"
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
              setStep("email");
              setCode("");
              setError(null);
            }}
            className="underline transition-colors hover:text-white"
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  // Email step (the sign-up front door).
  const canSubmit = pending === null && termsAccepted;
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onEmailSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email"
          className="h-12 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/30"
        />

        <div className="mt-1 flex flex-col gap-2.5 text-left">
          <label className="flex items-start gap-2.5 text-white/50 text-xs leading-5">
            <input
              type="checkbox"
              required
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              disabled={pending !== null}
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
              onChange={(e) => setProductNotes(e.target.checked)}
              disabled={pending !== null}
              className="mt-1 size-3.5 shrink-0 accent-accent"
            />
            <span>
              Send me product notes when something ships. Optional — unsubscribe
              is one click either way.
            </span>
          </label>
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="h-12 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {pending === "code" ? "Sending code…" : "Email me a sign-in code"}
        </button>
      </form>

      <button
        type="button"
        onClick={onMagic}
        disabled={pending !== null}
        className="text-sm text-white/50 underline transition-colors hover:text-white disabled:opacity-60"
      >
        {pending === "magic"
          ? "Sending…"
          : "Prefer a link? Email me a sign-in link"}
      </button>

      {githubEnabled ? (
        <>
          <div className="flex items-center gap-3 text-white/30 text-xs">
            <span className="h-px flex-1 bg-white/10" />
            or
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <button
            type="button"
            onClick={onGithub}
            disabled={pending !== null}
            className="flex h-12 items-center justify-center gap-2 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-5 font-medium text-white transition-colors hover:border-white/30 disabled:opacity-60"
          >
            {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
          </button>
        </>
      ) : null}

      {error ? <p className="text-sm text-accent">{error}</p> : null}
    </div>
  );
}
