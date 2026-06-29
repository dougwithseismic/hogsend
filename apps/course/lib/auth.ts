import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sendMagicLinkEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { emitSignedUp } from "@/lib/events";

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
