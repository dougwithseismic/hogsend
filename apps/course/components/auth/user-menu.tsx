"use client";

import { useRouter } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";

/** Session-aware control for the learn nav. Client-only (fetches the session on
 *  the client) so mounting it does NOT make the layout dynamic — first lessons
 *  stay statically generated. */
export function UserMenu() {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  if (isPending) return null;

  if (!session) {
    return (
      <a
        href="/sign-in"
        className="text-sm text-white/60 transition-colors hover:text-white"
      >
        Sign in
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.refresh();
      }}
      className="text-sm text-white/60 transition-colors hover:text-white"
    >
      Sign out
    </button>
  );
}
