"use client";

import { type FormEvent, useState } from "react";
import { signIn } from "@/lib/auth-client";

/** Passwordless sign-in: email magic-link + GitHub OAuth. `next` is a
 *  pre-validated relative path (see lib/safe-next) used as the callback target. */
export function SignInForm({
  next,
  githubEnabled,
}: {
  next: string;
  githubEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState<"magic" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onMagic(e: FormEvent) {
    e.preventDefault();
    setLoading("magic");
    setError(null);
    const res = await signIn.magicLink({ email, callbackURL: next });
    setLoading(null);
    if (res.error) {
      setError("Couldn't send the link. Check the address and try again.");
    } else {
      setSent(true);
    }
  }

  async function onGithub() {
    setLoading("github");
    setError(null);
    await signIn.social({ provider: "github", callbackURL: next });
  }

  if (sent) {
    return (
      <div className="rounded-md border border-white/[0.08] bg-white/[0.015] p-6">
        <p className="font-display text-xl tracking-[-0.02em]">
          Check your inbox
        </p>
        <p className="mt-2 text-sm text-white/60 leading-6">
          We sent a sign-in link to <span className="text-white">{email}</span>.
          It's single-use and expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onMagic} className="flex flex-col gap-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="h-12 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/30"
        />
        <button
          type="submit"
          disabled={loading !== null}
          className="h-12 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {loading === "magic" ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>

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
            disabled={loading !== null}
            className="flex h-12 items-center justify-center gap-2 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-5 font-medium text-white transition-colors hover:border-white/30 disabled:opacity-60"
          >
            {loading === "github" ? "Redirecting…" : "Continue with GitHub"}
          </button>
        </>
      ) : null}

      {error ? <p className="text-sm text-accent">{error}</p> : null}
    </div>
  );
}
