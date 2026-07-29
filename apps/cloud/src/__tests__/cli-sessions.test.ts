import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as pollRoute } from "../../app/api/cli/device/poll/route";
import { POST as mintRoute } from "../../app/api/cli/device/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cliDeviceCodes,
  cliRateLimits,
  cliSessions,
  cloudAuditLog,
  organizations,
} from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import { loginHref, loginRedirectTarget } from "../lib/auth-guard";
import {
  approveCliDevice,
  denyCliDevice,
  describeCliDevice,
  readCliSessionsView,
  revokeCliSession,
} from "../lib/cli-sessions-ops";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import { NotPermittedError } from "../lib/org-members";
import { provisionOrganization } from "../lib/org-provision";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import {
  CliDeviceCodeService,
  DEVICE_CODE_RETENTION_MS,
  DEVICE_CODE_TTL_MS,
  generateUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from "../services/cli-device-codes";
import { CLI_TOKEN_PREFIX, CliSessionService } from "../services/cli-sessions";
import { NotFoundError } from "../services/errors";
import { OrgService } from "../services/orgs";

/**
 * The CLI device flow, end to end, over the real routes and the real database.
 *
 * The properties under test are the ones a mock would let through:
 *  - a poll returns the token EXACTLY once, and the second poll gets nothing;
 *  - a user code cannot approve anything without a signed-in dashboard user —
 *    which is the entire reason the short code is allowed to be short;
 *  - an expired code cannot be approved, and says so;
 *  - a revoked session fails closed on its next use;
 *  - and nothing that reaches the audit log is a credential.
 *
 * The only injected part is the email transport (a spy), so no test can reach a
 * mail provider. Everything else — Better Auth, the routes, the schema — is
 * the real thing.
 */

const PASSWORD = "correct-horse-8";
const OWNER = "cli-test-owner@hogsend.test";
const PLAIN = "cli-test-plain@hogsend.test";
const OUTSIDER = "cli-test-outsider@hogsend.test";
const EMAILS = [OWNER, PLAIN, OUTSIDER];

const US_CELL = "cli-test-us-1";
const ORG_PREFIX = "CliTest";
/** Documentation-range addresses, so a bucket can never collide with a real one. */
const TEST_IP_PREFIX = "203.0.113.";

const sent: EmailMessage[] = [];
const spySender: EmailSender = {
  id: "spy",
  async send(message) {
    sent.push(message);
  },
};

const auth = createCloudAuth({ emailSender: spySender });
const orgService = new OrgService(db);
const deps = { auth, db };
const sessions = new CliSessionService(db);
const devices = new CliDeviceCodeService(db);

let orgA = "";
let orgB = "";
let ownerId = "";
let plainId = "";
let outsiderId = "";

/** A `cookie` header carrying a real signed-in session for `email`. */
async function signIn(email: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error(`sign-in returned no cookie for ${email}`);
  return new Headers({ cookie });
}

let ipCounter = 0;
/** A fresh address per case, so one test's rate budget is never another's. */
function freshIp(): string {
  ipCounter += 1;
  return `${TEST_IP_PREFIX}${ipCounter}`;
}

async function mint(
  options: { label?: string; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": options.ip ?? freshIp(),
  };
  return mintRoute(
    new Request("http://localhost:3004/api/cli/device", {
      method: "POST",
      headers,
      body: JSON.stringify(
        options.label === undefined ? {} : { label: options.label },
      ),
    }),
  );
}

async function poll(deviceCode: string, ip?: string): Promise<Response> {
  return pollRoute(
    new Request("http://localhost:3004/api/cli/device/poll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip ?? freshIp(),
      },
      body: JSON.stringify({ deviceCode }),
    }),
  );
}

/** Mint through the route and return the parsed body. */
async function mintCodes(label: string): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await mint({ label });
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, EMAILS));
  await db.delete(cells).where(eq(cells.name, US_CELL));
  await db
    .delete(cliRateLimits)
    .where(like(cliRateLimits.bucket, `%${TEST_IP_PREFIX}%`));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of EMAILS) {
    await auth.api.signUpEmail({
      body: { name: email.split("@")[0] as string, email, password: PASSWORD },
    });
  }
  const rows = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.email, EMAILS));
  ownerId = rows.find((row) => row.email === OWNER)?.id ?? "";
  plainId = rows.find((row) => row.email === PLAIN)?.id ?? "";
  outsiderId = rows.find((row) => row.email === OUTSIDER)?.id ?? "";

  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  const a = await provisionOrganization(
    { name: `${ORG_PREFIX} Alpha`, region: "us", headers: await signIn(OWNER) },
    { auth, orgService },
  );
  orgA = a.organizationId;

  const b = await provisionOrganization(
    {
      name: `${ORG_PREFIX} Beta`,
      region: "us",
      headers: await signIn(OUTSIDER),
    },
    { auth, orgService },
  );
  orgB = b.organizationId;

  // PLAIN joins org A with Better Auth's default role. The membership row is
  // the real thing (`listMembers` reads it); only the invitation email round
  // trip is skipped, because it is `members.test.ts`'s subject, not this one's.
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgA,
    userId: plainId,
    role: "member",
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("user codes", () => {
  it("draws from an alphabet with no look-alike characters", () => {
    for (const forbidden of ["0", "1", "I", "L", "O", "U"]) {
      expect(USER_CODE_ALPHABET.includes(forbidden)).toBe(false);
    }
    expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length);
  });

  it("generates XXXX-XXXX from that alphabet", () => {
    for (let n = 0; n < 50; n += 1) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const char of code.replace("-", "")) {
        expect(USER_CODE_ALPHABET.includes(char)).toBe(true);
      }
    }
  });

  it("accepts a code however a human typed it, and refuses a typo", () => {
    expect(normalizeUserCode("abcd-2345")).toBe("ABCD-2345");
    expect(normalizeUserCode(" abcd2345 ")).toBe("ABCD-2345");
    expect(normalizeUserCode("ABCD 2345")).toBe("ABCD-2345");
    // Outside the alphabet: a typo stays a typo rather than silently becoming
    // a DIFFERENT valid code.
    expect(normalizeUserCode("ABC0-2345")).toBeNull();
    expect(normalizeUserCode("ABCD-234")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });
});

describe("POST /api/cli/device — mint", () => {
  it("returns both codes, a bare verification URL and a bounded TTL", async () => {
    const body = await mintCodes("laptop.local");

    expect(body.deviceCode.startsWith("hscd_")).toBe(true);
    // 256 bits of entropy, base64url — nothing guessable.
    expect(body.deviceCode.length).toBeGreaterThan(40);
    expect(body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.verificationUrl.endsWith("/cli/approve")).toBe(true);
    // PRD: codes SHALL be short-lived (≤ 15 min).
    expect(body.expiresIn).toBeLessThanOrEqual(15 * 60);
    expect(body.expiresIn).toBe(Math.floor(DEVICE_CODE_TTL_MS / 1000));
    expect(body.interval).toBeGreaterThan(0);

    // Only the HASH is stored: the device code itself is never at rest.
    const [row] = await db
      .select()
      .from(cliDeviceCodes)
      .where(eq(cliDeviceCodes.userCode, body.userCode));
    expect(row?.status).toBe("pending");
    expect(row?.deviceCodeHash).not.toContain(body.deviceCode);
    expect(row?.label).toBe("laptop.local");
  });

  it("never hands out a link that carries the user code", async () => {
    // The ONE thing binding the browser that approves to the machine that
    // asked is the human transcribing the code. A `verification_uri_complete`
    // (RFC 8628 §3.3.1, optional exactly because of §5.4) would delete that
    // binding: a stranger mints here, sends the link to a signed-in victim,
    // and one click binds the stranger's CLI to the victim's organization.
    // The label is no substitute — this endpoint is unauthenticated, so the
    // attacker chooses it.
    const response = await mint({ label: "MacBook-Pro.local" });
    const body = (await response.json()) as Record<string, unknown>;
    const userCode = body.userCode as string;

    expect(body.verificationUrlComplete).toBeUndefined();
    expect(Object.keys(body)).not.toContain("verificationUrlComplete");
    expect(body.verificationUrl).not.toContain("?");
    // Nothing in the response pairs a URL with the code, under any key.
    for (const [key, value] of Object.entries(body)) {
      if (key === "userCode" || typeof value !== "string") continue;
      expect(value).not.toContain(userCode);
    }
  });

  it("rate-limits minting per address", async () => {
    const ip = freshIp();
    for (let n = 0; n < 10; n += 1) {
      expect((await mint({ ip })).status).toBe(200);
    }
    const refused = await mint({ ip });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

    // The budget is per address, not global.
    expect((await mint({ ip: freshIp() })).status).toBe(200);
  });

  it("counts refused requests too, so refusal cannot reset the budget", async () => {
    const bucket = `unit:${freshIp()}`;
    const options = { bucket, limit: 2, windowMs: 60_000, db };
    expect((await consumeRateLimit(options)).allowed).toBe(true);
    expect((await consumeRateLimit(options)).allowed).toBe(true);
    expect((await consumeRateLimit(options)).allowed).toBe(false);
    const fourth = await consumeRateLimit(options);
    expect(fourth.allowed).toBe(false);
    expect(fourth.count).toBe(4);

    // A new window is a new budget.
    const later = await consumeRateLimit({
      ...options,
      now: new Date(Date.now() + 120_000),
    });
    expect(later.allowed).toBe(true);
    expect(later.count).toBe(1);
  });

  it("cannot be escaped by rotating the forwarded-for value the caller wrote", async () => {
    // `x-forwarded-for` is append-only and CLIENT-writable: the caller writes
    // the first entry, the proxy appends the address it actually saw. Keying
    // on the first entry would hand out a fresh bucket per request — no limit
    // at all — so the budget below must be spent even though every request
    // claims a different origin.
    const observed = freshIp();
    const chain = (claimed: number) => `10.0.0.${claimed}, ${observed}`;

    for (let n = 0; n < 10; n += 1) {
      expect((await mint({ ip: chain(n) })).status).toBe(200);
    }
    const refused = await mint({ ip: chain(99) });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: "rate_limited" });
  });

  it("reads the address the trusted proxy observed, and nothing else", () => {
    const chain = (value: string) => new Headers({ "x-forwarded-for": value });
    // One trusted hop (the default): the last entry.
    expect(clientIp(chain("10.0.0.1, 203.0.113.9"))).toBe("203.0.113.9");
    // Two: the second from the end. A deploy behind Cloudflare AND Railway.
    expect(clientIp(chain("10.0.0.1, 203.0.113.9, 198.51.100.4"), 2)).toBe(
      "203.0.113.9",
    );
    // A chain shorter than the trusted depth did not come through those
    // proxies, so it buckets as `unknown` rather than as a value the caller
    // chose. Same for a header only a caller could have set.
    expect(clientIp(chain("10.0.0.1"), 2)).toBe("unknown");
    expect(clientIp(new Headers({ "x-real-ip": "10.0.0.1" }))).toBe("unknown");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("the device flow, end to end", () => {
  it("mints, polls pending, is approved, and yields a token once", async () => {
    const codes = await mintCodes("workstation");

    const pending = await poll(codes.deviceCode);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });

    const ownerHeaders = await signIn(OWNER);

    // The approve page can read the request — label and expiry, nothing secret.
    const described = await describeCliDevice(
      ownerHeaders,
      { userCode: codes.userCode.toLowerCase() },
      deps,
    );
    expect(described?.label).toBe("workstation");

    const decision = await approveCliDevice(
      ownerHeaders,
      { userCode: codes.userCode, confirmed: true },
      deps,
    );
    expect(decision.ok).toBe(true);

    const approved = await poll(codes.deviceCode);
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      status: string;
      token: string;
      sessionId: string;
      organizationId: string;
      userId: string;
    };
    expect(body.status).toBe("approved");
    expect(body.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    // Approval binds the approver and THEIR active organization.
    expect(body.organizationId).toBe(orgA);
    expect(body.userId).toBe(ownerId);

    // The token is accepted, and only its hash was stored.
    const verified = await sessions.verify({ token: body.token });
    expect(verified.found).toBe(true);
    if (verified.found) {
      expect(verified.session.id).toBe(body.sessionId);
      expect(verified.session.label).toBe("workstation");
      expect(body.token.endsWith(verified.session.last4)).toBe(true);
    }
    const [stored] = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, body.sessionId));
    expect(stored?.tokenHash).not.toContain(body.token);

    // SINGLE USE: the second poll gets the same stonewall as an unknown code,
    // and no second session is minted.
    const replay = await poll(codes.deviceCode);
    expect(await replay.json()).toEqual({ status: "expired" });
    const forCode = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.label, "workstation"));
    expect(forCode).toHaveLength(1);

    // The audit trail says a session was created, and carries no token
    // material — not the token, not its tail, not the hash.
    const trail = await db
      .select()
      .from(cloudAuditLog)
      .where(
        and(
          eq(cloudAuditLog.organizationId, orgA),
          eq(cloudAuditLog.subject, body.sessionId),
        ),
      );
    expect(trail.map((row) => row.action)).toContain("cli_session.created");
    const serialized = JSON.stringify(trail);
    expect(serialized).not.toContain(body.token);
    expect(serialized).not.toContain(body.token.slice(-4));
    expect(serialized).not.toContain(stored?.tokenHash ?? "never");
  });

  it("refuses a denied code and mints nothing", async () => {
    const codes = await mintCodes("denied-machine");
    const decision = await denyCliDevice(
      await signIn(OWNER),
      { userCode: codes.userCode },
      deps,
    );
    expect(decision.ok).toBe(true);

    const answer = await poll(codes.deviceCode);
    expect(await answer.json()).toEqual({ status: "denied" });

    const minted = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.label, "denied-machine"));
    expect(minted).toHaveLength(0);
  });

  it("refuses an expired code, at approval and at poll", async () => {
    // Minted in the past, so it is already past its TTL now. The clock is an
    // input to the service, so no test has to wait ten minutes.
    const stale = await devices.mint({
      label: "stale-machine",
      now: new Date(Date.now() - DEVICE_CODE_TTL_MS - 60_000),
    });

    const decision = await approveCliDevice(
      await signIn(OWNER),
      { userCode: stale.userCode, confirmed: true },
      deps,
    );
    expect(decision).toEqual({ ok: false, reason: "expired" });

    const answer = await poll(stale.deviceCode);
    expect(await answer.json()).toEqual({ status: "expired" });

    const [row] = await db
      .select()
      .from(cliDeviceCodes)
      .where(eq(cliDeviceCodes.userCode, stale.userCode));
    expect(row?.status).toBe("expired");
    expect(
      await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.label, "stale-machine")),
    ).toHaveLength(0);
  });

  it("refuses an unknown code and a second decision on a resolved one", async () => {
    const ownerHeaders = await signIn(OWNER);
    expect(
      await approveCliDevice(
        ownerHeaders,
        { userCode: "ZZZZ-ZZZZ", confirmed: true },
        deps,
      ),
    ).toEqual({ ok: false, reason: "not_found" });

    const codes = await mintCodes("twice");
    expect(
      (
        await approveCliDevice(
          ownerHeaders,
          { userCode: codes.userCode, confirmed: true },
          deps,
        )
      ).ok,
    ).toBe(true);
    expect(
      await denyCliDevice(ownerHeaders, { userCode: codes.userCode }, deps),
    ).toEqual({ ok: false, reason: "already_resolved" });
  });

  it("binds the approver's OWN organization, not the requester's choice", async () => {
    const codes = await mintCodes("outsider-machine");
    await approveCliDevice(
      await signIn(OUTSIDER),
      { userCode: codes.userCode, confirmed: true },
      deps,
    );
    const body = (await (await poll(codes.deviceCode)).json()) as {
      organizationId: string;
      userId: string;
    };
    expect(body.organizationId).toBe(orgB);
    expect(body.userId).toBe(outsiderId);
  });
});

describe("a user code is not a credential", () => {
  it("approves nothing without a signed-in dashboard user", async () => {
    const codes = await mintCodes("unsigned");

    // No session: every dashboard-side entry point refuses before it reaches
    // the code. This is the property that lets the user code be short.
    await expect(
      approveCliDevice(
        new Headers(),
        { userCode: codes.userCode, confirmed: true },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      denyCliDevice(new Headers(), { userCode: codes.userCode }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      describeCliDevice(new Headers(), { userCode: codes.userCode }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);

    // Still pending, still approvable by a human — nothing was consumed.
    expect(await (await poll(codes.deviceCode)).json()).toEqual({
      status: "pending",
    });
  });

  it("approves nothing the human did not explicitly confirm", async () => {
    // The other half of the anti-phishing rule (the first is that no link ever
    // carries the code). A signed-in victim who opens a stranger's approve URL
    // has to both TYPE the code and say they started the login; a POST that
    // skips the confirmation — which is all a hand-rolled form submission is —
    // is refused rather than trusted, because a checkbox is markup.
    const codes = await mintCodes("unconfirmed-machine");
    const ownerHeaders = await signIn(OWNER);

    expect(
      await approveCliDevice(
        ownerHeaders,
        { userCode: codes.userCode, confirmed: false },
        deps,
      ),
    ).toEqual({ ok: false, reason: "not_confirmed" });

    // Nothing was bound and nothing was consumed: the login is still pending
    // and no session exists for it.
    expect(await (await poll(codes.deviceCode)).json()).toEqual({
      status: "pending",
    });
    expect(
      await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.label, "unconfirmed-machine")),
    ).toHaveLength(0);

    // And the same code is still approvable once it IS confirmed.
    expect(
      (
        await approveCliDevice(
          ownerHeaders,
          { userCode: codes.userCode, confirmed: true },
          deps,
        )
      ).ok,
    ).toBe(true);
  });

  it("sends a signed-out visitor to sign-in and back, code intact", () => {
    const target = loginRedirectTarget({
      pathname: "/cli/approve",
      search: "?code=ABCD-2345",
    });
    expect(target.pathname).toBe("/login");
    expect(target.search).toBe(
      `?next=${encodeURIComponent("/cli/approve?code=ABCD-2345")}`,
    );
    // An absolute destination cannot be smuggled through the round trip.
    expect(loginHref("//evil.example/steal")).toBe("/login");
    expect(loginHref("https://evil.example")).toBe("/login");
    expect(loginHref("/")).toBe("/login");
  });
});

describe("lapsed device codes are deleted", () => {
  /** A code minted far enough in the past that it is past RETENTION, not TTL. */
  async function mintAncient(label: string): Promise<string> {
    const { userCode } = await devices.mint({
      label,
      now: new Date(
        Date.now() - DEVICE_CODE_RETENTION_MS - DEVICE_CODE_TTL_MS - 60_000,
      ),
    });
    return userCode;
  }

  async function exists(userCode: string): Promise<boolean> {
    const rows = await db
      .select({ id: cliDeviceCodes.id })
      .from(cliDeviceCodes)
      .where(eq(cliDeviceCodes.userCode, userCode));
    return rows.length > 0;
  }

  it("reaps codes past retention and keeps the live ones", async () => {
    const ancient = await mintAncient("ancient-machine");
    const live = await devices.mint({ label: "live-machine" });
    // Expired minutes ago, so it is garbage in STATUS but not yet in age —
    // an operator looking at this morning's failed login must still find it.
    const recentlyExpired = await devices.mint({
      label: "recently-expired-machine",
      now: new Date(Date.now() - DEVICE_CODE_TTL_MS - 60_000),
    });

    const { deleted } = await devices.reap();
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await exists(ancient)).toBe(false);
    expect(await exists(live.userCode)).toBe(true);
    expect(await exists(recentlyExpired.userCode)).toBe(true);
  });

  it("prunes from the mint route, so the table cannot grow forever", async () => {
    // `cli_device_codes` only ever grows from this UNAUTHENTICATED endpoint,
    // and nothing else in the app deletes from it — the lazy `expired` writes
    // free nothing. So the mint that OPENS a rate-limit window sweeps.
    const ancient = await mintAncient("route-reaped-machine");
    expect(await exists(ancient)).toBe(true);

    const response = await mint({ label: "sweeper", ip: freshIp() });
    expect(response.status).toBe(200);

    expect(await exists(ancient)).toBe(false);
  });
});

describe("Settings — CLI sessions", () => {
  it("lists live sessions for the organization and hides revoked ones", async () => {
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "listed-machine",
    });

    const view = await readCliSessionsView(await signIn(OWNER), deps);
    const listed = view.sessions.find((row) => row.id === summary.id);
    expect(listed).toBeDefined();
    expect(listed?.label).toBe("listed-machine");
    expect(listed?.userEmail).toBe(OWNER);
    expect(token.endsWith(listed?.last4 ?? "nope")).toBe(true);
    expect(listed?.lastUsedAt).toBeNull();
    // The list is a view, not a vault: no token, no hash.
    expect(JSON.stringify(view.sessions)).not.toContain(token);

    await revokeCliSession(
      await signIn(OWNER),
      { sessionId: summary.id },
      deps,
    );
    const after = await readCliSessionsView(await signIn(OWNER), deps);
    expect(after.sessions.find((row) => row.id === summary.id)).toBeUndefined();
  });

  it("fails a revoked session closed on its next use", async () => {
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "revoked-machine",
    });
    expect((await sessions.verify({ token })).found).toBe(true);

    await revokeCliSession(
      await signIn(OWNER),
      { sessionId: summary.id },
      deps,
    );

    // Not "revoked" — INVALID. Every caller's correct response is identical.
    expect(await sessions.verify({ token })).toEqual({ found: false });
    // And it stays revoked: a use after revocation cannot stamp last_used_at.
    expect(await sessions.touch({ sessionId: summary.id })).toEqual({
      touched: false,
    });
  });

  it("keeps the first revocation instant when revoked twice", async () => {
    const { summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "twice-revoked",
    });
    const first = await sessions.revoke({
      sessionId: summary.id,
      organizationId: orgA,
    });
    const second = await sessions.revoke({
      sessionId: summary.id,
      organizationId: orgA,
    });
    expect(second.revokedAt?.toISOString()).toBe(
      first.revokedAt?.toISOString(),
    );
  });

  it("lets a member revoke their own session but not another's", async () => {
    const mine = await sessions.create({
      userId: plainId,
      organizationId: orgA,
      label: "plain-own",
    });
    const theirs = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "owner-owned",
    });

    const plainHeaders = await signIn(PLAIN);
    await revokeCliSession(plainHeaders, { sessionId: mine.summary.id }, deps);
    expect(await sessions.verify({ token: mine.token })).toEqual({
      found: false,
    });

    await expect(
      revokeCliSession(plainHeaders, { sessionId: theirs.summary.id }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);
    // An owner may revoke anyone's.
    await revokeCliSession(
      await signIn(OWNER),
      { sessionId: theirs.summary.id },
      deps,
    );
    expect(await sessions.verify({ token: theirs.token })).toEqual({
      found: false,
    });
  });

  it("treats another organization's session id as not found", async () => {
    const foreign = await sessions.create({
      userId: outsiderId,
      organizationId: orgB,
      label: "foreign-machine",
    });

    await expect(
      revokeCliSession(
        await signIn(OWNER),
        { sessionId: foreign.summary.id },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Untouched.
    expect((await sessions.verify({ token: foreign.token })).found).toBe(true);

    // And it is not visible in the other org's list either.
    const view = await readCliSessionsView(await signIn(OWNER), deps);
    expect(view.sessions.some((row) => row.id === foreign.summary.id)).toBe(
      false,
    );
  });

  it("throttles last-used writes rather than writing per request", async () => {
    const { summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "busy-machine",
    });

    expect(await sessions.touch({ sessionId: summary.id })).toEqual({
      touched: true,
    });
    // A second use seconds later must NOT write: a build-status poll every few
    // seconds would otherwise be a write per poll.
    expect(await sessions.touch({ sessionId: summary.id })).toEqual({
      touched: false,
    });
    // Past the staleness window it moves again.
    expect(
      await sessions.touch({
        sessionId: summary.id,
        now: new Date(Date.now() + 120_000),
      }),
    ).toEqual({ touched: true });
  });
});
