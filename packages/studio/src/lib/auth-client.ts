import { createAuthClient } from "better-auth/react";
import { config } from "./config";

/**
 * Better Auth React client. The server mounts Better Auth at `/api/auth`
 * (see engine `lib/auth.ts` -> `basePath: "/api/auth"`), so the client
 * baseURL is `${origin}/api/auth`. Cookies are sent same-origin when mounted
 * under /studio; for the standalone CLI a cross-origin baseUrl is supplied.
 */
export const authClient = createAuthClient({
  baseURL: `${config.baseUrl}/api/auth`,
  fetchOptions: {
    credentials: "include",
  },
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  // Self-service password reset (better-auth client, 1.6.x). `requestPasswordReset`
  // emails the link (engine mailer); `resetPassword` consumes the `?token=` from
  // the reset link and sets the new password. Both return the neutral
  // `{ data, error }` shape the forms surface.
  requestPasswordReset,
  resetPassword,
} = authClient;
