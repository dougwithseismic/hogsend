"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { authClient, signIn } from "@/lib/auth-client";

type Pending = null | "code" | "verify" | "magic" | "github" | "resend";

/**
 * Passwordless sign-in for the docs site. Primary path is a 6-digit email code
 * the visitor types on this same tab (no inbox round-trip); the magic link and
 * GitHub OAuth are fallbacks. Collects a FIRST NAME (Doug's call — keeps the
 * demo's personalised greeting): it is set on the account after sign-in via
 * `updateUser` (OTP path) and passed to `signIn.magicLink` (link path), so the
 * `/api/hogsend-token` fold later persists it onto the contact.
 *
 * `next` is a pre-validated relative path used as the callback/return target;
 * after sign-in the whole document navigates there so the destination
 * re-renders with the new session (the demo unlocks + the bell identifies).
 */
export function SignInForm({
  next,
  githubEnabled,
}: {
  next: string;
  githubEnabled: boolean;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
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

  const cleanName = () => firstName.trim() || undefined;

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
    // Persist the first name on the fresh session (best-effort — a name-set
    // failure must not block the sign-in itself).
    const name = cleanName();
    if (name) {
      await authClient.updateUser({ name }).catch(() => {});
    }
    // Full navigation so the destination re-renders with the new session.
    window.location.assign(next);
  }

  function onCodeChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && pending === null) {
      void verify(digits);
    }
  }

  async function onMagic() {
    if (!email) {
      setError("Enter your email first.");
      return;
    }
    setPending("magic");
    setError(null);
    const res = await signIn.magicLink({
      email,
      name: cleanName(),
      callbackURL: next,
    });
    setPending(null);
    if (res.error) {
      setError("Couldn't send the link. Check the address and try again.");
    } else {
      setMagicSent(true);
    }
  }

  async function onGithub() {
    setPending("github");
    setError(null);
    await signIn.social({ provider: "github", callbackURL: next });
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

        <div className="border-white/[0.08] border-t pt-4">
          <button
            type="button"
            onClick={onMagic}
            disabled={pending !== null}
            className="text-sm text-white/50 underline transition-colors hover:text-white disabled:opacity-60"
          >
            {pending === "magic"
              ? "Sending…"
              : "Email me a sign-in link instead"}
          </button>
        </div>
      </div>
    );
  }

  // Email step.
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onEmailSubmit} className="flex flex-col gap-3">
        <input
          type="text"
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="First name"
          aria-label="First name"
          className="h-12 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/30"
        />
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
        <button
          type="submit"
          disabled={pending !== null}
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
