"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { updateUser } from "@/lib/auth-client";

/**
 * Edit the display name (Better Auth updateUser, shared `.hogsend.com`
 * account, so it carries to the course too); email is read-only — it's the
 * passwordless sign-in identity. The docs sibling of the course app's
 * ProfileForm.
 */
export function ProfileForm({
  initialName,
  email,
}: {
  initialName: string;
  email: string;
}) {
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  const dirty = name.trim() !== initialName.trim() && name.trim().length > 0;

  async function save() {
    if (!dirty) return;
    setStatus("saving");
    const { error } = await updateUser({ name: name.trim() });
    if (error) {
      setStatus("error");
      return;
    }
    setStatus("saved");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm text-white/60">
          Name
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={120}
          autoComplete="name"
          onChange={(e) => {
            setName(e.target.value);
            setStatus("idle");
          }}
          placeholder="Your name"
          className="w-full max-w-sm rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-base text-white placeholder-white/30 outline-none transition-colors focus:border-accent/60"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={emailId} className="text-sm text-white/60">
          Email
        </label>
        <input
          id={emailId}
          value={email}
          readOnly
          className="w-full max-w-sm cursor-not-allowed rounded-md border border-white/[0.08] bg-white/[0.015] px-3.5 py-2.5 text-base text-white/50 outline-none"
        />
        <span className="text-white/40 text-xs">
          This is your sign-in. Access is passwordless — you sign in with a
          magic link, so there&apos;s no password to reset.
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || status === "saving"}
          className="inline-flex h-10 w-fit items-center rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        {status === "saved" ? (
          <span className="text-sm text-white/50">Saved.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-red-400/90 text-sm">
            Couldn&apos;t save — try again.
          </span>
        ) : null}
      </div>
    </div>
  );
}
