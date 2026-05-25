import type { Database } from "@hogsend/db";
import * as schema from "@hogsend/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";

export function createAuth(opts: {
  db: Database;
  secret: string;
  baseURL: string;
}) {
  const { db, secret, baseURL } = opts;
  return betterAuth({
    basePath: "/api/auth",
    secret,
    baseURL,
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
