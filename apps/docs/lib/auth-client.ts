"use client";

import { emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client for the docs site. Same-origin by default (the API is
 * mounted at /api/auth here), so no base URL is needed. The session cookie is
 * shared with course.hogsend.com (same secret + same DB + `.hogsend.com` cookie
 * domain in production), so `useSession` sees a course login too.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), emailOTPClient()],
});

export const { signIn, signOut, useSession, updateUser } = authClient;
