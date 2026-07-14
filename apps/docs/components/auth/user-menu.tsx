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
 * Session-aware nav control for the marketing nav — the sibling of the course
 * app's UserMenu. Signed out it's a quiet "Sign in" link (the "Start building"
 * CTA keeps top billing); signed in it's an initials avatar opening a
 * Portal / Course / Sign out dropdown. Client-only (session fetched in the
 * browser via the shared `.hogsend.com` cookie), so mounting it does NOT make
 * the marketing layout dynamic. Dependency-free dropdown (click-outside +
 * Escape).
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

  // Reserve the avatar's footprint while the session loads — no nav shift.
  // `hidden sm:block` matches the signed-out link's breakpoints: on mobile the
  // resolved states render nothing (signed-out) or pop the avatar (signed-in),
  // so reserving space there would guarantee a shift for the common case.
  if (isPending) {
    return (
      <div
        className="hidden size-8 rounded-full bg-white/[0.04] sm:block"
        aria-hidden
      />
    );
  }

  if (!session) {
    return (
      <Link
        href="/sign-in?next=/portal"
        className="hidden font-medium text-sm text-white/75 tracking-[-0.025em] transition-colors hover:text-white sm:inline"
      >
        Sign in
      </Link>
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
        className="flex size-8 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] font-medium text-white/90 text-xs transition-colors hover:border-white/30"
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
              href="/portal"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              Portal
            </Link>
            <a
              href="https://course.hogsend.com"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              Course
            </a>
          </div>
          <div className="border-white/[0.08] border-t py-1">
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                try {
                  await signOut();
                } catch {
                  return; // failed sign-out: stay signed in, no redirect
                }
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
