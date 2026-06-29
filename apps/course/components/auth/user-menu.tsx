"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";

/** Initials for the avatar — from the name if present, else the email. */
function initials(name?: string | null, email?: string | null): string {
  const src = (name?.trim() || email || "?").trim();
  const parts = src.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

/**
 * Session-aware nav control: a "Sign in / Create account" pair when logged out,
 * an avatar button with a Profile / My courses / Sign out dropdown when logged
 * in. Client-only (fetches the session in the browser) so mounting it does NOT
 * make a layout dynamic. Dependency-free dropdown (click-outside + Escape).
 */
export function UserMenu() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reserve space while the session loads to avoid nav layout shift.
  if (isPending) {
    return (
      <div className="h-8 w-20 rounded-full bg-white/[0.04]" aria-hidden />
    );
  }

  if (!session) {
    return (
      <div className="flex items-center gap-4">
        <Link
          href="/sign-in"
          className="text-sm text-white/60 transition-colors hover:text-white"
        >
          Sign in
        </Link>
        <Link
          href="/sign-in"
          className="rounded-full bg-white px-3.5 py-1.5 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90"
        >
          Create account
        </Link>
      </div>
    );
  }

  const user = session.user;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] font-medium text-white/90 text-xs transition-colors hover:border-white/30"
      >
        {initials(user.name, user.email)}
      </button>

      {open ? (
        <div
          role="menu"
          className="glass-panel absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl"
        >
          <div className="border-white/[0.08] border-b px-4 py-3">
            <p className="truncate font-medium text-sm text-white">
              {user.name || "Your account"}
            </p>
            <p className="truncate text-white/50 text-xs">{user.email}</p>
          </div>
          <div className="py-1">
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              Profile
            </Link>
            <Link
              href="/"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              My courses
            </Link>
          </div>
          <div className="border-white/[0.08] border-t py-1">
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                await signOut();
                router.push("/");
                router.refresh();
              }}
              className="block w-full px-4 py-2 text-left text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
