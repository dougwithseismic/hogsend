"use client";

import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client for the control plane.
 *
 * No `baseURL`: the auth handler is mounted on this same origin
 * (`app/api/auth/[...all]`), so the default relative base is correct in dev,
 * preview and production alike — and there is no public env var to keep in sync
 * with `CLOUD_PUBLIC_URL`.
 *
 * The plugin list must mirror the SERVER plugin list in `./auth.ts`; each client
 * plugin only exists to type and route the endpoints its server half adds.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [emailOTPClient(), organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
