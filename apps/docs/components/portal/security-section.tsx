"use client";

import { useState } from "react";
import { revokeOtherSessions } from "@/lib/auth-client";

/**
 * Security controls. Passwordless, so there's no password reset — the useful
 * control is revoking sessions on other devices. Sessions are shared across
 * `*.hogsend.com`, so this ends them on the course and demo too.
 */
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
        you shouldn&apos;t have.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={signOutEverywhere}
          disabled={status === "working"}
          className="inline-flex h-10 w-fit items-center rounded-[8px] border border-white/[0.12] px-4 font-medium text-sm text-white/80 transition-colors hover:border-white/30 hover:text-white disabled:opacity-40"
        >
          {status === "working" ? "Working…" : "Sign out everywhere else"}
        </button>
        {status === "done" ? (
          <span className="text-sm text-white/50">Other sessions ended.</span>
        ) : null}
        {status === "error" ? (
          <span className="text-red-400/90 text-sm">
            Couldn&apos;t do that — retry.
          </span>
        ) : null}
      </div>
    </div>
  );
}
