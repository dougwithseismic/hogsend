import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins/email-otp";
import { organization } from "better-auth/plugins/organization";
import { db } from "../db";
import * as authSchema from "../db/schema/auth";
import { DEFAULT_CLOUD_PUBLIC_URL, DEV_CLOUD_AUTH_SECRET, env } from "../env";
import { CLOUD_COOKIE_PREFIX } from "./auth-cookie";
import { type EmailSender, resolveEmailSender } from "./email-sender";

export { CLOUD_COOKIE_PREFIX, CLOUD_SESSION_COOKIE_NAME } from "./auth-cookie";

function otpSubject(type: string): string {
  return type === "forget-password"
    ? "Reset your Hogsend Cloud password"
    : "Your Hogsend Cloud verification code";
}

export function createCloudAuth(opts?: { emailSender?: EmailSender }) {
  const sender = opts?.emailSender ?? resolveEmailSender();

  return betterAuth({
    basePath: "/api/auth",
    // `??` guards the `SKIP_ENV_VALIDATION=true` build, where t3-env hands back
    // raw process.env and the schema defaults above are not applied.
    secret: env.CLOUD_AUTH_SECRET ?? DEV_CLOUD_AUTH_SECRET,
    baseURL: env.CLOUD_PUBLIC_URL ?? DEFAULT_CLOUD_PUBLIC_URL,
    advanced: { cookiePrefix: CLOUD_COOKIE_PREFIX },
    database: drizzleAdapter(db, {
      provider: "pg",
      // Only the auth tables — passing the whole barrel would let the adapter
      // resolve the `organization` model against the control plane's
      // `organizations` MIRROR table, which has a different shape.
      schema: authSchema,
    }),
    emailAndPassword: {
      // Public sign-up is ON here. The engine closes it (admins are minted by
      // CLI); the cloud is the self-serve front door, so this is the one Better
      // Auth instance in the repo where an unauthenticated caller may create a
      // user.
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // No session until the OTP is entered. Better Auth would otherwise sign
      // the user in on sign-up, and the route guard (session cookie present →
      // dashboard) would bounce them off the verify step they are standing on.
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
      },
    },
    plugins: [
      emailOTP({
        // The code is mailed the moment the account is created, so the signup
        // screen can go straight to the verify step with nothing else to click.
        // NOTE: this flag is honoured by the plugin's own post-sign-up hook,
        // which it disables if `overrideDefaultEmailVerification` is set — so
        // that option must stay OFF. There is no link-based verification path
        // in this app for it to override anyway.
        sendVerificationOnSignUp: true,
        expiresIn: 60 * 10,
        async sendVerificationOTP({ email, otp, type }) {
          await sender.send({
            to: email,
            subject: otpSubject(type),
            text: `Your Hogsend Cloud verification code is ${otp}. It expires in 10 minutes.`,
          });
        },
      }),
      organization({
        organizationLimit: 5,
        membershipLimit: 100,
      }),
    ],
  });
}

export const auth = createCloudAuth();

export type CloudAuth = ReturnType<typeof createCloudAuth>;
