import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink } from "better-auth/plugins";
import { sendMagicLinkEmail, sendOtpEmail } from "@/lib/auth-email";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * The docs site's Better Auth instance. It is a SIBLING of the course's
 * (apps/course/lib/auth.ts), not a copy of its session: both point at the SAME
 * user DB (env.DATABASE_URL) and sign with the SAME secret (env.BETTER_AUTH_SECRET),
 * and — in production — set the session cookie on the shared parent domain
 * (AUTH_COOKIE_DOMAIN = `.hogsend.com`). That trio is what makes ONE login work
 * across `*.hogsend.com`: a session created on either site is a row the other
 * reads and a cookie the browser sends to both. Passwordless, matching course:
 * a 6-digit email code (primary) + a magic link (fallback) + optional GitHub.
 */
const baseURL = env.BETTER_AUTH_URL;

// GitHub OAuth lights up only when both creds are present (registering it with
// empty creds would make the button 400 at GitHub).
const githubConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
);

// Cross-subdomain SSO: set AUTH_COOKIE_DOMAIN to `.hogsend.com` in production so
// the session cookie is shared across subdomains. Left UNSET in local dev
// (localhost has no shared parent domain), where each app keeps a host-only
// cookie. The course sets the SAME env var, so both emit the shared-domain cookie.
const cookieDomain = process.env.AUTH_COOKIE_DOMAIN;
// The sibling origin (course) — trusted for auth requests. Optional.
const siblingOrigin = process.env.AUTH_SIBLING_ORIGIN;

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: siblingOrigin ? [baseURL, siblingOrigin] : [baseURL],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Passwordless only — email code / magic link + GitHub.
  emailAndPassword: { enabled: false },
  socialProviders: githubConfigured
    ? {
        github: {
          clientId: process.env.GITHUB_CLIENT_ID as string,
          clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
        },
      }
    : {},
  // Link a GitHub login to an existing user ONLY when the verified email matches
  // (github is deliberately NOT trusted for auto-linking; magic-link/OTP only
  // create verified users, and GitHub returns a verified primary email).
  account: { accountLinking: { enabled: true } },
  ...(cookieDomain
    ? {
        advanced: {
          crossSubDomainCookies: { enabled: true, domain: cookieDomain },
        },
      }
    : {}),
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  plugins: [
    // Primary passwordless method: a 6-digit code the visitor types on the same
    // tab (no inbox round-trip). Creates the user on first sign-in.
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 15,
      disableSignUp: false,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === "sign-in") {
          await sendOtpEmail(email, otp);
        }
      },
    }),
    // Fallback: the single-use link, for visitors who'd rather click than type.
    magicLink({
      expiresIn: 60 * 15,
      disableSignUp: false,
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail(email, url);
      },
    }),
    // nextCookies MUST be last — it flushes Set-Cookie on responses.
    nextCookies(),
  ],
});
