"use client";

import { useId, useState } from "react";
import { ACTION_FAILED, postPortalAction } from "./post-action";

/**
 * The portal's "book a call" — the signed-in replacement for the public
 * enquiry form. Identity comes from the session server-side, so the only
 * input is the note; the confirmation email (with the booking link when
 * configured) lands in their inbox.
 */

const MESSAGE_MAX = 1000;

export function BookCall({ email }: { email: string }) {
  const inputId = useId();
  // Stable per-mount id so a double-submit dedupes upstream but a genuine
  // re-request from a fresh visit is distinct.
  const [submissionId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setStatus("sending");
    setError(null);
    const res = await postPortalAction("/api/portal/book-call", {
      submissionId,
      ...(message.trim() ? { message: message.trim() } : {}),
    });
    if (!res.ok) {
      setError(ACTION_FAILED);
      setStatus("idle");
      return;
    }
    setStatus("sent");
  }

  if (status === "sent") {
    return (
      <p className="text-sm text-white/70">
        Request sent — confirmation and times are on their way to {email}.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm text-white/60">
          What do you want to cover? (optional)
        </label>
        <textarea
          id={inputId}
          value={message}
          rows={3}
          maxLength={MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Scoping the next piece, a working session, where the funnel leaks…"
          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-base text-white placeholder-white/30 outline-none transition-colors focus:border-accent/60 focus:bg-white/[0.04]"
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={status === "sending"}
          onClick={submit}
          className="inline-flex h-10 w-fit items-center rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {status === "sending" ? "Sending…" : "Request a call"}
        </button>
        {error ? (
          <span className="text-red-400/90 text-xs">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
