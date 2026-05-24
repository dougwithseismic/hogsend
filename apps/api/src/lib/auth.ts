import type { Database } from "@hogsend/db";
import * as schema from "@hogsend/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";

export function createAuth(
  db: Database,
  config: { secret: string; baseURL: string },
) {
  return betterAuth({
    basePath: "/api/auth",
    secret: config.secret,
    baseURL: config.baseURL,
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
