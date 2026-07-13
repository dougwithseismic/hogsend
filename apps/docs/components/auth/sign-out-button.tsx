"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/lib/auth-client";

/** The portal's sign-out control — ends the shared `.hogsend.com` session. */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await signOut();
          router.push("/");
          router.refresh();
        } finally {
          // A failed sign-out (flaky network) must not strand the button in
          // "Signing out…" — reset so the user can retry.
          setPending(false);
        }
      }}
      className="inline-flex h-10 items-center rounded-[8px] border border-white/[0.12] px-4 font-medium text-sm text-white/80 transition-colors hover:border-white/30 hover:text-white disabled:opacity-60"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
