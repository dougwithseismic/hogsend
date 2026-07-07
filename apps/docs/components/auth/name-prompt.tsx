"use client";

import { type FormEvent, useState } from "react";
import { authClient, useSession } from "@/lib/auth-client";

/**
 * Post-sign-in first-name capture, asked GLOBALLY and PROGRESSIVELY. Renders
 * only when a visitor is signed in but has no name — so it covers EVERY sign-in
 * path (OTP, magic-link, GitHub) uniformly at the destination, not just the
 * same-tab OTP flow. Most visitors never see it: Better Auth's user-create hook
 * reuses a name we already know for the email from Hogsend, and returning
 * accounts keep their name. A small fixed banner; dismissible.
 */
export function NamePrompt() {
  const { data: session } = useSession();
  const [firstName, setFirstName] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const needsName = Boolean(session) && !(session?.user.name ?? "").trim();
  if (!needsName || dismissed) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const name = firstName.trim();
    if (!name) return;
    setSaving(true);
    await authClient.updateUser({ name }).catch(() => {});
    // Reload so the greeting + bell pick up the new name from the session.
    window.location.reload();
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-white/[0.08] border-t bg-ink/95 backdrop-blur">
      <form
        onSubmit={save}
        className="mx-auto flex max-w-2xl flex-wrap items-center gap-3 px-6 py-4"
      >
        <span className="text-sm text-white/70">
          Welcome — what should we call you?
        </span>
        <input
          type="text"
          required
          autoComplete="given-name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          placeholder="First name"
          aria-label="First name"
          className="h-10 min-w-40 flex-1 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-3 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-white/30"
        />
        <button
          type="submit"
          disabled={saving || firstName.trim().length === 0}
          className="h-10 rounded-[10px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-sm text-white/40 underline transition-colors hover:text-white/70"
        >
          Not now
        </button>
      </form>
    </div>
  );
}
