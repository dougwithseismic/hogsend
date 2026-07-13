"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * The click-wrap signature form: type your full name, tick "I agree", sign.
 * A success refreshes the server component, which re-renders the agreement
 * with its signed state from the authoritative record.
 */
export function SignAgreement({
  docId,
  docVersion,
}: {
  docId: string;
  docVersion: string;
}) {
  const router = useRouter();
  const inputId = useId();
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSign = name.trim().length >= 2 && agreed && !pending;

  async function sign() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/agreements/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, docVersion, signedName: name.trim() }),
      });
      if (!res.ok) {
        setError(
          res.status === 409
            ? "This document was updated — refresh to review the current version."
            : "That didn't take — try again in a moment.",
        );
        return;
      }
      router.refresh();
    } catch {
      setError("That didn't take — try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-white/[0.08] border-t pt-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm text-white/60">
          Type your full name to sign
        </label>
        <input
          id={inputId}
          type="text"
          value={name}
          maxLength={120}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          className="w-full max-w-sm rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-base text-white placeholder-white/30 outline-none transition-colors focus:border-accent/60"
          placeholder="Jane Rivera"
        />
      </div>
      <label className="flex items-start gap-2.5 text-white/60 text-xs leading-5">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 size-3.5 shrink-0 accent-accent"
        />
        <span>
          I have read this agreement and I agree to it. Typing my name above is
          my signature.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!canSign}
          onClick={sign}
          className="inline-flex h-10 w-fit items-center rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Signing…" : "Agree & sign"}
        </button>
        {error ? (
          <span className="text-red-400/90 text-xs">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
