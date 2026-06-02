import type { Database } from "@hogsend/db";
import * as schema from "@hogsend/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";

export function createAuth(opts: {
  db: Database;
  secret: string;
  baseURL: string;
  /**
   * Extra origins allowed to call auth endpoints, beyond `baseURL` (which is
   * always trusted). Needed when the Studio is served from a different origin
   * than the API (e.g. the `hogsend studio` CLI against a remote instance).
   */
  trustedOrigins?: string[];
}) {
  const { db, secret, baseURL, trustedOrigins } = opts;
  return betterAuth({
    basePath: "/api/auth",
    secret,
    baseURL,
    ...(trustedOrigins && trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      organization({
        organizationLimit: 5,
        membershipLimit: 100,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
