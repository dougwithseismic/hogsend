"use client";

import { Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type JSX, useId, useState } from "react";
import { useSession } from "@/lib/auth-client";

/**
 * "Request a call" form for the done-for-you tier — the consultative path that
 * replaces the old mailto. It posts to /api/service-inquiry, which forwards a
 * `service.call_requested` lifecycle event into Hogsend; the dogfood journey
 * off that event sends the prospect an instant confirmation (with a booking
 * link) and notifies the operator. So the whole booking lifecycle runs on
 * Hogsend itself — the form is the only surface here.
 *
 * Signed-in visitors (course/docs SSO) get their name + email prefilled; no
 * account is required to enquire. A per-mount submission id + a disabled
 * in-flight button keep a double-click from creating two leads.
 */

type Status = "idle" | "submitting" | "done" | "error";

const NAME_MAX = 80;
const COMPANY_MAX = 120;
const MESSAGE_MAX = 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inputClass =
  "w-full rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-base text-white placeholder-white/30 outline-none transition-colors focus:border-accent/60 focus:bg-white/[0.04]";

export function ServiceInquiryForm(): JSX.Element {
  const { data: session } = useSession();
  const baseId = useId();
  // Stable per-mount id so a double-submit dedupes upstream but a genuine
  // re-enquiry from a fresh visit is a distinct lead.
  const [submissionId] = useState(() => crypto.randomUUID());

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [touchedFromSession, setTouchedFromSession] = useState(false);
  // Explicit consent, same as the subscribe/demo forms: a required terms
  // checkbox gates submission (the enquiry IS a real, consented sign-up), and
  // an optional product-updates opt-in.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productNotes, setProductNotes] = useState(false);

  // Prefill name/email from an existing SSO session once it resolves, without
  // clobbering anything the visitor has already typed.
  if (session?.user && !touchedFromSession) {
    setTouchedFromSession(true);
    if (session.user.name) setName(session.user.name);
    if (session.user.email) setEmail(session.user.email);
  }

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const canSubmit = emailValid && termsAccepted && status !== "submitting";

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus("submitting");
    try {
      const res = await fetch("/api/service-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          name: name.trim() || undefined,
          email: email.trim(),
          company: company.trim() || undefined,
          message: message.trim() || undefined,
          termsAccepted,
          productNotes,
        }),
      });
      setStatus(res.ok ? "done" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="glass-panel flex flex-col items-start gap-3 rounded-xl p-8">
        <span className="grid size-10 place-items-center rounded-full border border-accent/40 bg-accent/10 text-accent">
          <Check className="size-5" strokeWidth={2} />
        </span>
        <h3 className="font-display text-[22px] text-white leading-[1.2] tracking-[-0.02em]">
          Got it — I&apos;ll be in touch
        </h3>
        <p className="max-w-md text-base text-white/70 leading-7">
          Check your inbox: there&apos;s a note from me with a link to grab a
          time that works. The first conversation is about your product and
          where the funnel leaks — not a feature list.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-panel flex flex-col gap-4 rounded-xl p-6 md:p-8"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${baseId}-name`} className="text-sm text-white/60">
            Name
          </label>
          <input
            id={`${baseId}-name`}
            type="text"
            value={name}
            maxLength={NAME_MAX}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Jane Rivera"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${baseId}-email`} className="text-sm text-white/60">
            Email <span className="text-accent">*</span>
          </label>
          <input
            id={`${baseId}-email`}
            type="email"
            required
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="jane@yourproduct.com"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${baseId}-company`} className="text-sm text-white/60">
          Product or company
        </label>
        <input
          id={`${baseId}-company`}
          type="text"
          value={company}
          maxLength={COMPANY_MAX}
          autoComplete="organization"
          onChange={(e) => setCompany(e.target.value)}
          className={inputClass}
          placeholder="Acme — B2B analytics"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${baseId}-message`} className="text-sm text-white/60">
          Where do you think the funnel leaks?
        </label>
        <textarea
          id={`${baseId}-message`}
          value={message}
          maxLength={MESSAGE_MAX}
          rows={4}
          onChange={(e) => setMessage(e.target.value)}
          className={`${inputClass} resize-y`}
          placeholder="Trials stall before activation, and we never win cancels back…"
        />
      </div>

      <div className="flex flex-col gap-2.5 text-left">
        <label className="flex items-start gap-2.5 text-white/50 text-xs leading-5">
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
            . I&apos;ll follow up by email.
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-white/50 text-xs leading-5">
          <input
            type="checkbox"
            checked={productNotes}
            onChange={(e) => setProductNotes(e.target.checked)}
            disabled={status === "submitting"}
            className="mt-1 size-3.5 shrink-0 accent-accent"
          />
          <span>
            Send me product notes when something ships. Optional — unsubscribe
            is one click either way.
          </span>
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={!canSubmit}
          className="group inline-flex h-12 items-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "submitting" ? (
            <>
              <Loader2 className="size-4 animate-spin" strokeWidth={2} />
              <span>Sending…</span>
            </>
          ) : (
            <span>Request a call</span>
          )}
        </button>
        <p className="eyebrow text-white/50">
          Done-for-you · $1,500/mo · 3-month minimum
        </p>
      </div>

      {status === "error" ? (
        <p className="text-sm text-red-400/90">
          Something went wrong sending that. Email{" "}
          <a
            href="mailto:doug@withseismic.com"
            className="underline underline-offset-2"
          >
            doug@withseismic.com
          </a>{" "}
          and I&apos;ll pick it up.
        </p>
      ) : null}
    </form>
  );
}
