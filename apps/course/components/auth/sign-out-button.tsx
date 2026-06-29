"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

/** Standalone sign-out button for the account page. */
export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.push("/");
        router.refresh();
      }}
      className="rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-5 py-2.5 font-medium text-sm text-white transition-colors hover:border-white/30"
    >
      Sign out
    </button>
  );
}
