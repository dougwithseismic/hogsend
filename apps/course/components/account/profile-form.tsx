"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { updateUser } from "@/lib/auth-client";

/** Edit the display name (Better Auth updateUser); email is read-only (it's the
 *  passwordless sign-in identity). */
export function ProfileForm({
  initialName,
  email,
}: {
  initialName: string;
  email: string;
}) {
  const router = useRouter();
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
      <label className="flex flex-col gap-1.5">
        <span className="text-sm text-white/60">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setStatus("idle");
          }}
          className="w-full rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-3.5 py-2.5 text-sm text-white outline-none transition-colors focus:border-white/30"
          placeholder="Your name"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm text-white/60">Email</span>
        <input
          value={email}
          readOnly
          className="w-full cursor-not-allowed rounded-[10px] border border-white/[0.08] bg-white/[0.015] px-3.5 py-2.5 text-sm text-white/50 outline-none"
        />
        <span className="text-white/40 text-xs">
          This is your sign-in. Account access is passwordless — you sign in
          with a magic link, so there's no password to reset.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || status === "saving"}
          className="rounded-[10px] bg-white px-4 py-2 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        {status === "saved" ? (
          <span className="text-sm text-white/50">Saved.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-accent text-sm">
            Couldn't save — try again.
          </span>
        ) : null}
      </div>
    </div>
  );
}
