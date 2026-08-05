import { asc, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments } from "../db/schema";
import { user as authUser, member } from "../db/schema/auth";
import { CliSessionService } from "../services/cli-sessions";
import { IllegalRegionError } from "../services/errors";
import type { CloudRegion } from "../services/orgs";
import type { CloudAuth } from "./auth";
import { auth as defaultAuth } from "./auth";
import {
  type ProvisionOrganizationDeps,
  provisionOrganization,
} from "./org-provision";

/**
 * The whole of `hogsend signup`'s second round trip, as one function: verify
 * the OTP, create the user if there is not one, give them an organization if
 * they have none, and mint the CLI session token.
 *
 * It lives here rather than in the route so the RULES are testable without an
 * HTTP shape, and because every one of them is a rule rather than a step:
 *
 *  - **Verification comes first, and is Better Auth's.** `signInEmailOTP`
 *    owns the code, its TTL, its single-use consume and its attempt budget
 *    (three, then the code is burned and the identifier locked out). It also
 *    owns user creation: a correct code for an unknown address creates the
 *    user with `emailVerified: true`. Nothing here re-implements any of that.
 *  - **A returning user is LOGGED IN, never re-signed-up.** An organization is
 *    created ONLY when the user belongs to none. `--org` from somebody who
 *    already has one is reported back (`org_ignored_existing`) and otherwise
 *    ignored: a second organization is a real decision with real billing, and
 *    a flag on a login is not how it gets made.
 *  - **The token appears exactly once.** `CliSessionService.create` returns
 *    the plaintext and stores only its sha256; this function passes it
 *    straight out and keeps no copy.
 *  - **Wrong-code refusals cannot be told apart by email.** Verification runs
 *    before this module knows or asks whether the address is registered, so a
 *    bad code answers the same for both.
 */

/** Why a verify was refused. Each maps to a distinct answer for the CLI. */
export type CliSignupRefusal =
  | "invalid_code"
  | "code_expired"
  | "code_burned"
  | "no_region";

export type CompleteCliSignupResult =
  | {
      ok: true;
      userId: string;
      organizationId: string;
      environmentId: string | null;
      token: string;
      sessionId: string;
      created: { user: boolean; organization: boolean };
      /** Set when an `org` name was sent by somebody who already had one. */
      note: "org_ignored_existing" | null;
    }
  | { ok: false; refusal: CliSignupRefusal };

export interface CompleteCliSignupInput {
  email: string;
  otp: string;
  /** Optional organization NAME, honoured only for a user with no org. */
  org?: string;
  /** Where a new organization's infrastructure lives. */
  region?: CloudRegion;
  /** The `hogsend login` label — a hostname, like the device flow's. */
  label?: string;
}

export interface CompleteCliSignupDeps {
  db?: CloudDb;
  auth?: CloudAuth;
  sessions?: CliSessionService;
  /** Passed through to `provisionOrganization`; see its own deps. */
  provisionDeps?: ProvisionOrganizationDeps;
  /** Overrides the `CLOUD_PROVISION_ON` policy. Tests only. */
  provision?: boolean;
}

/** Better Auth's `emailOTP` codes, mapped onto ours. */
function refusalFor(error: unknown): CliSignupRefusal {
  const code = (error as { body?: { code?: unknown } })?.body?.code;
  if (code === "OTP_EXPIRED") return "code_expired";
  if (code === "TOO_MANY_ATTEMPTS") return "code_burned";
  return "invalid_code";
}

/**
 * A first organization name from the address the human just proved they hold.
 *
 * The local part, not the domain: `dougsilkstone@gmail.com` becoming an
 * organization called "Gmail" would be absurd, and the local part is at least
 * the person's own handle. It is only a display name — the slug that has to be
 * DNS-safe is derived from it downstream by `slugifyOrgName`, which never
 * refuses.
 */
export function defaultOrgName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "My workspace";
}

export async function completeCliSignup(
  input: CompleteCliSignupInput,
  deps: CompleteCliSignupDeps = {},
): Promise<CompleteCliSignupResult> {
  const db = deps.db ?? defaultDb;
  const auth = deps.auth ?? defaultAuth;
  const sessions = deps.sessions ?? new CliSessionService(db);
  const email = input.email.toLowerCase();

  // BEFORE the verify, because the verify is what creates the user: asked
  // afterwards, every signup would look like a login. Nothing is revealed by
  // reading it — the answer only ever reaches a caller who then proved they
  // hold the inbox.
  const [existing] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email))
    .limit(1);
  const userExisted = existing !== undefined;

  let userId: string;
  try {
    // No headers passed: this is a headless call and the browser session
    // cookie Better Auth would set has nobody to set it on. The CLI's
    // credential is the `hscli_` token minted below, not a session cookie.
    const verified = await auth.api.signInEmailOTP({
      body: { email, otp: input.otp },
    });
    userId = verified.user.id;
  } catch (error) {
    return { ok: false, refusal: refusalFor(error) };
  }

  // Which organizations is this human in? Read from `member` directly rather
  // than through Better Auth's `/organization/list`, which requires a session
  // this flow deliberately does not have. Oldest first, so a returning user
  // lands in the same organization every time.
  const memberships = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt), asc(member.id));

  let organizationId = memberships[0]?.organizationId ?? null;
  let organizationCreated = false;
  let note: "org_ignored_existing" | null = null;

  if (organizationId === null) {
    try {
      const provisioned = await provisionOrganization(
        {
          name: input.org?.trim() || defaultOrgName(email),
          region: input.region ?? "us",
          plan: "trial",
          userId,
          ...(deps.provision === undefined
            ? {}
            : { provision: deps.provision }),
        },
        deps.provisionDeps ?? {},
      );
      organizationId = provisioned.organizationId;
      organizationCreated = true;
    } catch (error) {
      // No cell in the region will take this tenant. An ordinary refusal with
      // an operator's name on it, not a bug: `provisionOrganization` has
      // already rolled the Better Auth organization back, so the user exists
      // (their inbox is proven) with no half-created tenant behind them.
      if (error instanceof IllegalRegionError) {
        return { ok: false, refusal: "no_region" };
      }
      throw error;
    }
  } else if (input.org && input.org.trim().length > 0) {
    note = "org_ignored_existing";
  }

  // The production environment is what `hogsend publish` targets by default.
  // Read rather than assumed: an org created before this flow existed, or one
  // whose production environment was renamed, still answers correctly.
  const owned = await db
    .select({ id: environments.id, kind: environments.kind })
    .from(environments)
    .where(eq(environments.organizationId, organizationId))
    .orderBy(asc(environments.createdAt), asc(environments.id));
  const environment =
    owned.find((row) => row.kind === "production") ?? owned[0];

  const issued = await sessions.create({
    userId,
    organizationId,
    label: input.label ?? "email-otp",
    actor: userId,
  });

  return {
    ok: true,
    userId,
    organizationId,
    environmentId: environment?.id ?? null,
    token: issued.token,
    sessionId: issued.summary.id,
    created: { user: !userExisted, organization: organizationCreated },
    note,
  };
}
