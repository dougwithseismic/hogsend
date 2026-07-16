"use client";

import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type JSX, useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

type Status = "idle" | "submitting" | "done" | "error";

/**
 * PlaybookCapture — the "one play a week" form. Posts to
 * /api/playbook-subscribe, which forwards `playbook.subscribed` (plus the
 * explicit `playbook-weekly` list opt-in) to the Hogsend ingest API; the
 * dogfood's `playbook-weekly` journey takes it from there. The playbook's
 * own nurture running on Hogsend is part of the pitch.
 */
export function PlaybookCapture({
  placement,
  className,
}: {
  /** Where the form is mounted — non-PII analytics property. */
  placement: "index" | "play";
  className?: string;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setStatus("submitting");
    try {
      const res = await fetch("/api/playbook-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, termsAccepted }),
      });
      if (res.ok) {
        capture(AnalyticsEvent.CAPTURE_SUBMITTED, {
          placement: `playbook-${placement}`,
        });
        setStatus("done");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border border-white/[0.08] bg-white/[0.02] p-5",
          className,
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent">
          <Check aria-hidden="true" className="size-4" strokeWidth={2} />
        </span>
        <p className="text-sm text-white/70">
          You&apos;re in — play one is on its way from hello@hogsend.com.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border border-white/[0.08] bg-white/[0.02] p-5",
        className,
      )}
    >
      <p className="font-medium text-base text-white tracking-[-0.02em]">
        One play a week
      </p>
      <p className="mt-1 text-sm text-white/55">
        The rotation, by email — twelve plays, one per week, run by a Hogsend
        journey. Unsubscribe is one click.
      </p>
      <form
        onSubmit={handleSubmit}
        className="mt-4 flex flex-col gap-3 sm:flex-row"
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email address"
          autoComplete="email"
          disabled={status === "submitting"}
          className="h-11 w-full min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/35 focus:border-white/25 focus:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex h-11 shrink-0 select-none items-center justify-center gap-2 rounded-md bg-white px-5 font-medium text-[#0a0606] text-sm tracking-[-0.02em] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {status === "submitting" ? "Sending…" : "Get the plays"}
          {status === "submitting" ? null : (
            <ArrowRight aria-hidden="true" className="size-4" strokeWidth={2} />
          )}
        </button>
      </form>
      <label className="mt-3 flex items-start gap-2.5 text-white/50 text-xs leading-5">
        <input
          type="checkbox"
          required
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
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
          .
        </span>
      </label>
      {status === "error" ? (
        <p className="mt-3 text-sm text-white/70">
          That didn&apos;t take. Try again.
        </p>
      ) : null}
    </div>
  );
}
