"use client";

import { emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client for the docs site. Same-origin by default (the API is
 * mounted at /api/auth here), so no base URL is needed. The session cookie is
 * shared with course.hogsend.com (same secret + same DB + `.hogsend.com` cookie
 * domain in production), so `useSession` sees a course login too.
 *
 * `refetchOnWindowFocus` is turned OFF: better-auth defaults it ON, and the
 * focus-triggered refetch flips `useSession`'s pending state, which was
 * unmounting the inline sign-in form mid-flow — wiping the 6-digit code a
 * visitor tabbed away to their inbox to fetch. The docs session only changes on
 * an explicit sign-in/out (both navigate), so a focus refetch buys nothing.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), emailOTPClient()],
  sessionOptions: { refetchOnWindowFocus: false },
});

export const { signIn, signOut, useSession, updateUser, revokeOtherSessions } =
  authClient;
