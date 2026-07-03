"use client";

import { emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. Same-origin by default (the API is mounted at
 * /api/auth on this site), so no NEXT_PUBLIC_* base URL is needed.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), emailOTPClient()],
});

export const {
  signIn,
  signOut,
  useSession,
  updateUser,
  deleteUser,
  listSessions,
  revokeOtherSessions,
} = authClient;
