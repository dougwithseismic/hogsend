"use client";

import { useState } from "react";
import { revokeOtherSessions } from "@/lib/auth-client";

/** Security controls. Passwordless, so there's no password reset — the useful
 *  control is revoking sessions on other devices. */
export function SecuritySection() {
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );

  async function signOutEverywhere() {
    setStatus("working");
    const { error } = await revokeOtherSessions();
    setStatus(error ? "error" : "done");
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-white/60 leading-6">
        Sign out everywhere ends every other session (other browsers and
        devices) but keeps you signed in here. Use it if you signed in somewhere
        you shouldn't have.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={signOutEverywhere}
          disabled={status === "working"}
          className="self-start rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 py-2 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-40"
        >
          {status === "working" ? "Working…" : "Sign out everywhere else"}
        </button>
        {status === "done" ? (
          <span className="text-sm text-white/50">Other sessions ended.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-accent text-sm">Couldn't do that — retry.</span>
        ) : null}
      </div>
    </div>
  );
}
