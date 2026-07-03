import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  sendDeleteAccountEmail,
  sendMagicLinkEmail,
  sendOtpEmail,
} from "@/lib/email";
import { env } from "@/lib/env";
import { emitAccountDeleted, emitSignedUp } from "@/lib/events";

const baseURL = env.BETTER_AUTH_URL;

// GitHub OAuth lights up only when both creds are present. Magic-link ships
// first; set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (runtime) to enable it.
// Registering the provider with empty creds would make the button 400 at GitHub.
const githubConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
);

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL,
  // secret + baseURL come from lib/env: build-only placeholders during
  // `next build`, but a THROW at real runtime if unset — so a misconfigured boot
  // can never sign sessions with a committed constant or collapse trustedOrigins.
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [baseURL],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Passwordless only — magic-link + GitHub.
  emailAndPassword: { enabled: false },
  socialProviders: githubConfigured
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID as string,
          clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
        },
      }
    : {},
  // Link a GitHub login to an existing user ONLY when the verified email matches.
  // github is deliberately NOT in trustedProviders, so linking requires a
  // verified-email match (magic-link only creates verified users; GitHub returns
  // a verified primary email) — safe convergence, no takeover.
  account: { accountLinking: { enabled: true } },
  user: {
    // GDPR right-to-erasure. Passwordless, so deletion is confirmed by an
    // emailed single-use link (not a password). Deleting the user row cascades
    // via FK to session/account/enrollment/lesson_progress/purchase. Stripe
    // financial records are retained per legal/tax obligation (Art. 17(3)(b)).
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async ({ user, url }) => {
        await sendDeleteAccountEmail(user.email, url);
      },
      afterDelete: async (user) => {
        await emitAccountDeleted({ id: user.id, email: user.email });
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          await emitSignedUp({
            id: createdUser.id,
            email: createdUser.email,
            name: createdUser.name,
          });
        },
      },
    },
  },
  plugins: [
    // Primary passwordless method: a 6-digit code the reader types on the same
    // tab — no inbox round-trip. Creates the user on first sign-in (same as the
    // magic link), so the signed_up hook fires for new accounts either way.
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 15,
      disableSignUp: false,
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Only the sign-in flow is used here (no email-change / password reset).
        if (type === "sign-in") {
          await sendOtpEmail(email, otp);
        }
      },
    }),
    // Fallback: the single-use link, for readers who'd rather click than type.
    magicLink({
      expiresIn: 60 * 15,
      disableSignUp: false,
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail(email, url);
      },
    }),
    // nextCookies MUST be the last plugin — it flushes Set-Cookie on responses.
    nextCookies(),
  ],
});
