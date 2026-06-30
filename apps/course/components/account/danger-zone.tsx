"use client";

import { useState } from "react";
import { deleteUser } from "@/lib/auth-client";

/** GDPR controls: export all data (right to access) and delete the account
 *  (right to erasure). Deletion is type-to-confirm AND email-verified — calling
 *  deleteUser sends a single-use confirmation link; nothing is removed until the
 *  user clicks it. */
export function DangerZone() {
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const armed = confirm.trim().toUpperCase() === "DELETE";

  async function requestDeletion() {
    if (!armed) return;
    setStatus("sending");
    const { error } = await deleteUser({ callbackURL: "/?deleted=1" });
    setStatus(error ? "error" : "sent");
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-white/60 leading-6">
          Download everything we hold for your account — profile, course
          progress, purchases, and invoice records — as a JSON file.
        </p>
        <a
          href="/api/account/export"
          className="self-start rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 py-2 font-medium text-sm text-white transition-colors hover:border-white/30"
        >
          Download my data
        </a>
      </div>

      <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-5">
        <p className="font-medium text-sm text-white">Delete account</p>
        <p className="mt-1.5 text-sm text-white/60 leading-6">
          Permanently deletes your profile, course progress, and purchase
          records and signs you out everywhere. Course access is lost and this
          can't be undone. Payment/invoice records are retained where the law
          requires (tax and accounting). You'll get an email to confirm —
          nothing is deleted until you click it.
        </p>
        {status === "sent" ? (
          <p className="mt-4 text-sm text-white/80">
            Check your inbox — we've emailed a confirmation link. Your account
            stays active until you click it.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type DELETE to confirm"
              className="w-full rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-3.5 py-2.5 text-sm text-white outline-none transition-colors focus:border-accent/60 sm:max-w-[220px]"
            />
            <button
              type="button"
              onClick={requestDeletion}
              disabled={!armed || status === "sending"}
              className="rounded-[10px] bg-accent px-4 py-2.5 font-medium text-sm text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "sending" ? "Sending…" : "Delete my account"}
            </button>
          </div>
        )}
        {status === "error" ? (
          <p className="mt-3 text-accent text-sm">
            Couldn't start deletion — please try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
