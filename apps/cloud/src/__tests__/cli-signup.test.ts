import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as environmentsRoute } from "../../app/api/cli/environments/route";
import { POST as signupRoute } from "../../app/api/cli/signup/route";
import { POST as verifyRoute } from "../../app/api/cli/signup/verify/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cliRateLimits,
  environments,
  organizations,
  stacks,
} from "../db/schema";
import { member, organization, user, verification } from "../db/schema/auth";
import { env } from "../env";
import { completeCliSignup, defaultOrgName } from "../lib/cli-signup";
import { CliSessionService } from "../services/cli-sessions";

/**
 * `hogsend signup` and `hogsend login --email`, over the REAL routes, the REAL
 * Better Auth instance and the REAL database.
 *
 * A mocked auth adapter would certify nothing here, because every claim this
 * PRD makes is about Better Auth's actual behaviour: that a `"sign-in"` OTP is
 * mailed for an unknown address, that verifying one creates the user with
 * `emailVerified: true`, and that its attempt budget burns the code. So the OTP
 * is read out of the `verification` row Better Auth wrote (plain storage, the
 * plugin default) rather than out of a mailbox — the transport is the log
 * sender in tests, so nothing can reach a mail provider either way.
 *
 * The laws under test:
 *  - **Enumeration parity.** The send leg answers identically for a registered
 *    and an unknown address, and so does a WRONG-code verify. Asserted by
 *    comparing the two responses byte for byte, not by reading one and
 *    trusting the other.
 *  - **The attempt budget burns.** Three wrong codes and the code is dead —
 *    including for somebody who then types the RIGHT one.
 *  - **A signup produces a working credential.** The token is exercised
 *    against a real authenticated endpoint, because a token that parses but
 *    does not authenticate would pass every shape assertion.
 *  - **A returning user is logged in, never re-signed-up.** No second
 *    organization, whatever `--org` says.
 *  - **The policy is honoured both ways.** `first-publish` defers and enqueues
 *    nothing; `signup` enqueues, exactly as before PRD 15.
 */

const NEW_EMAIL = "cli-signup-new@hogsend.test";
const RETURNING_EMAIL = "cli-signup-returning@hogsend.test";
const PARITY_EMAIL = "cli-signup-parity@hogsend.test";
const BURN_EMAIL = "cli-signup-burn@hogsend.test";
const LIMIT_EMAIL = "cli-signup-limit@hogsend.test";
const POLICY_EMAIL = "cli-signup-policy@hogsend.test";
const EMAILS = [
  NEW_EMAIL,
  RETURNING_EMAIL,
  PARITY_EMAIL,
  BURN_EMAIL,
  LIMIT_EMAIL,
  POLICY_EMAIL,
];

const US_CELL = "cli-signup-us-1";
const sessions = new CliSessionService(db);

/**
 * A distinct address per case. The per-IP rate limit is a real limit against a
 * real table, and every request in this file would otherwise share the
 * `unknown` bucket and start refusing each other half way through the suite.
 */
function ipHeaders(label: string): Record<string, string> {
  return { "x-forwarded-for": `203.0.113.${hashByte(label)}` };
}

function hashByte(value: string): number {
  let total = 0;
  for (const char of value) total = (total + char.charCodeAt(0)) % 250;
  return total + 1;
}

function post(
  route: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  label: string,
): Promise<Response> {
  return route(
    new Request(`http://localhost:3004${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders(label) },
      body: JSON.stringify(body),
    }),
  );
}

const signup = (body: unknown, label = "default") =>
  post(signupRoute, "/api/cli/signup", body, label);

const verify = (body: unknown, label = "default") =>
  post(verifyRoute, "/api/cli/signup/verify", body, label);

/**
 * The code Better Auth just wrote, read from the verification row it stores it
 * in. `storeOTP` defaults to plain, and the value is `<otp>:<attempts>`.
 */
async function otpFor(email: string): Promise<string> {
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, `sign-in-otp-${email}`))
    .limit(1);
  if (!row) throw new Error(`no OTP was issued for ${email}`);
  const at = row.value.lastIndexOf(":");
  return at === -1 ? row.value : row.value.slice(0, at);
}

async function cleanup(): Promise<void> {
  const users = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.email, EMAILS));
  const userIds = users.map((row) => row.id);

  if (userIds.length > 0) {
    const orgIds = (
      await db
        .select({ id: member.organizationId })
        .from(member)
        .where(inArray(member.userId, userIds))
    ).map((row) => row.id);
    if (orgIds.length > 0) {
      // The mirror first: it is keyed BY the Better Auth id.
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
      await db.delete(organization).where(inArray(organization.id, orgIds));
    }
  }
  // Sessions cascade off the user; the user cascades nothing else here.
  await db.delete(user).where(inArray(user.email, EMAILS));
  await db
    .delete(verification)
    .where(like(verification.identifier, "sign-in-otp-cli-signup-%"));
  await db.delete(cells).where(eq(cells.name, US_CELL));
  await db
    .delete(cliRateLimits)
    .where(like(cliRateLimits.bucket, "cli_signup_%"));
  await db
    .delete(cliRateLimits)
    .where(like(cliRateLimits.bucket, "cli_verify_%"));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 20,
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end({ timeout: 5 });
});

describe("POST /api/cli/signup", () => {
  it("mails a code for an address nobody has ever used", async () => {
    const response = await signup({ email: NEW_EMAIL }, NEW_EMAIL);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("sent");

    // A real six-digit code, really stored, really addressed to this inbox.
    expect(await otpFor(NEW_EMAIL)).toMatch(/^\d{6}$/);

    // And no user was created by ASKING. The code proves the inbox; until it
    // comes back, an address anybody can type is nobody's account.
    const rows = await db.select().from(user).where(eq(user.email, NEW_EMAIL));
    expect(rows).toEqual([]);
  });

  it("refuses a malformed address without sending anything", async () => {
    const response = await signup({ email: "not-an-email" }, "malformed");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_email");
    const rows = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, "sign-in-otp-not-an-email"));
    expect(rows).toEqual([]);
  });

  it("answers IDENTICALLY for a registered address and an unknown one", async () => {
    // Make PARITY_EMAIL a real, verified user with an organization first.
    await signup({ email: PARITY_EMAIL }, PARITY_EMAIL);
    const first = await verify(
      { email: PARITY_EMAIL, otp: await otpFor(PARITY_EMAIL) },
      PARITY_EMAIL,
    );
    expect(first.status).toBe(200);

    const known = await signup({ email: PARITY_EMAIL }, "parity-a");
    const unknown = await signup(
      { email: "cli-signup-never-seen@hogsend.test" },
      "parity-b",
    );

    // Byte for byte. A field that varied — a flag, a different message, even a
    // different key order — would be an account-existence oracle on an
    // unauthenticated endpoint.
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("refuses past the per-email ceiling, with a retry-after", async () => {
    // The email bucket is the one an attacker cannot rotate, so it is the one
    // asserted: three codes per ten minutes, then refusal.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await signup({ email: LIMIT_EMAIL }, `limit-${attempt}`);
      expect(allowed.status).toBe(200);
    }

    const refused = await signup({ email: LIMIT_EMAIL }, "limit-final");
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});

describe("POST /api/cli/signup/verify", () => {
  it("creates the user, the org, a DEFERRED stack and a working token", async () => {
    const response = await verify(
      { email: NEW_EMAIL, otp: await otpFor(NEW_EMAIL), label: "test-laptop" },
      NEW_EMAIL,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      created: { user: boolean; organization: boolean };
      token: string;
      sessionId: string;
      userId: string;
      organizationId: string;
      environmentId: string;
      note: string | null;
    };

    expect(body.status).toBe("ok");
    expect(body.created).toEqual({ user: true, organization: true });
    expect(body.note).toBeNull();
    expect(body.token.startsWith("hscli_")).toBe(true);

    // The user exists AND is verified: the code was the proof, so there is no
    // second verification step waiting for them in a browser.
    const [created] = await db
      .select()
      .from(user)
      .where(eq(user.email, NEW_EMAIL));
    expect(created?.id).toBe(body.userId);
    expect(created?.emailVerified).toBe(true);

    // One organization, with the caller as its owner.
    const members = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.userId, body.userId),
          eq(member.organizationId, body.organizationId),
        ),
      );
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");

    // A production environment, and a stack that has asked for NOTHING yet:
    // `CLOUD_PROVISION_ON` defaults to `first-publish`, so a drive-by
    // verification costs no substrate.
    const [environment] = await db
      .select()
      .from(environments)
      .where(eq(environments.id, body.environmentId));
    expect(environment?.kind).toBe("production");
    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.environmentId, body.environmentId));
    expect(stack?.status).toBe("deferred");

    // THE assertion about the token: it authenticates. A shape check would
    // pass for a string that opens nothing.
    const listed = await environmentsRoute(
      new Request("http://localhost:3004/api/cli/environments", {
        headers: { authorization: `Bearer ${body.token}` },
      }),
    );
    expect(listed.status).toBe(200);
    const view = (await listed.json()) as {
      organization: { id: string };
      environments: { id: string; stackStatus: string | null }[];
    };
    expect(view.organization.id).toBe(body.organizationId);
    expect(
      view.environments.find((row) => row.id === body.environmentId)
        ?.stackStatus,
    ).toBe("deferred");

    // The session is the one the response named, and nothing stored is a
    // token — `verify` finds it by hash.
    const found = await sessions.verify({ token: body.token });
    expect(found.found && found.session.id).toBe(body.sessionId);
  });

  it("logs a returning user into their EXISTING org, ignoring --org", async () => {
    await signup({ email: RETURNING_EMAIL }, RETURNING_EMAIL);
    const first = await verify(
      { email: RETURNING_EMAIL, otp: await otpFor(RETURNING_EMAIL) },
      RETURNING_EMAIL,
    );
    const firstBody = (await first.json()) as {
      organizationId: string;
      userId: string;
    };

    // Second time round, asking for an organization they may not have.
    await signup({ email: RETURNING_EMAIL }, RETURNING_EMAIL);
    const second = await verify(
      {
        email: RETURNING_EMAIL,
        otp: await otpFor(RETURNING_EMAIL),
        org: "A Second Company",
      },
      RETURNING_EMAIL,
    );
    const secondBody = (await second.json()) as {
      created: { user: boolean; organization: boolean };
      organizationId: string;
      token: string;
      sessionId: string;
      note: string | null;
    };

    expect(second.status).toBe(200);
    expect(secondBody.created).toEqual({ user: false, organization: false });
    expect(secondBody.organizationId).toBe(firstBody.organizationId);
    // Named, not silently dropped: the CLI prints it so the human knows why
    // their `--org` did nothing.
    expect(secondBody.note).toBe("org_ignored_existing");

    // Still exactly one membership, and no second organization anywhere.
    const memberships = await db
      .select()
      .from(member)
      .where(eq(member.userId, firstBody.userId));
    expect(memberships).toHaveLength(1);
    const named = await db
      .select()
      .from(organization)
      .where(eq(organization.name, "A Second Company"));
    expect(named).toEqual([]);

    // A fresh session each time — the old one is not reused or rotated.
    expect(secondBody.sessionId).not.toBe("");
    const live = await sessions.verify({ token: secondBody.token });
    expect(live.found).toBe(true);
  });

  it("burns the code after the attempt budget, then refuses the RIGHT one", async () => {
    await signup({ email: BURN_EMAIL }, BURN_EMAIL);
    const correct = await otpFor(BURN_EMAIL);
    const wrong = correct === "000000" ? "111111" : "000000";

    // Three wrong tries is the plugin's budget (shared with the browser).
    const codes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await verify(
        { email: BURN_EMAIL, otp: wrong },
        BURN_EMAIL,
      );
      expect(response.status).toBe(401);
      codes.push(((await response.json()) as { error: string }).error);
    }
    expect(codes).toEqual(["invalid_code", "invalid_code", "invalid_code"]);

    // The budget is spent, so the code is dead — for everybody, including the
    // person who now types it correctly. Without this, a guessing script would
    // simply request a new code and keep the old one's guesses.
    const burned = await verify(
      { email: BURN_EMAIL, otp: correct },
      BURN_EMAIL,
    );
    expect(burned.status).toBe(401);
    expect(((await burned.json()) as { error: string }).error).toBe(
      "code_burned",
    );

    // And no account was created by any of it.
    const rows = await db.select().from(user).where(eq(user.email, BURN_EMAIL));
    expect(rows).toEqual([]);
  });

  it("answers a wrong code identically for a known and an unknown address", async () => {
    // PARITY_EMAIL is a registered, verified user by now; the other has never
    // been seen. Better Auth verifies the code BEFORE it looks a user up, so
    // the two must be indistinguishable.
    const known = await verify(
      { email: PARITY_EMAIL, otp: "999999" },
      "wrong-a",
    );
    const unknown = await verify(
      { email: "cli-signup-never-seen@hogsend.test", otp: "999999" },
      "wrong-b",
    );

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });
});

describe("completeCliSignup", () => {
  it("enqueues provisioning immediately under CLOUD_PROVISION_ON=signup", async () => {
    await signup({ email: POLICY_EMAIL }, POLICY_EMAIL);
    const enqueued: string[] = [];

    const result = await completeCliSignup(
      { email: POLICY_EMAIL, otp: await otpFor(POLICY_EMAIL) },
      {
        // The signup policy, pinned. The enqueue is intercepted so no
        // infrastructure work runs against this suite's fake cell DSN.
        provision: true,
        provisionDeps: {
          enqueueProvision: async (stackId) => {
            enqueued.push(stackId);
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.environmentId, result.environmentId ?? ""));
    // Today's behaviour, preserved exactly: born `requested`, and handed to
    // the provisioner with no operator action.
    expect(stack?.status).toBe("requested");
    expect(enqueued).toEqual([stack?.id]);
  });

  it("names a first organization after the human, not their mail provider", () => {
    expect(defaultOrgName("doug.silkstone@gmail.com")).toBe("doug silkstone");
    expect(defaultOrgName("ops@acme.io")).toBe("ops");
    expect(defaultOrgName("@nothing.test")).toBe("My workspace");
  });
});
