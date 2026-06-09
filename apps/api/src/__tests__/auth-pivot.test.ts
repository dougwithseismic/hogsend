import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point at the local growthhog Timescale (matches the other live-DB suites).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so building a container never dials a live engine.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { user } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { bootstrapAdminFromEnv, createApp, createHogsendClient } = await import(
  "@hogsend/engine"
);

type Container = ReturnType<typeof createHogsendClient>;

/**
 * The auth pivot: the setup-token web first-admin gate is GONE. The security
 * invariant is now enforced one layer down — public sign-up is closed at the
 * better-auth layer (`disableSignUp: true`), and admins are minted only by the
 * CLI / the env bootstrap. This suite proves both halves:
 *
 *  1. POST /api/auth/sign-up/email is rejected for EVERYONE (400
 *     EMAIL_PASSWORD_SIGN_UP_DISABLED) — there is NO unauthenticated network
 *     path that creates a user.
 *  2. `bootstrapAdminFromEnv` mints the first admin from env exactly once, and
 *     is a no-op once any user exists.
 *
 * Both halves are DB-backed (the rejection comes from better-auth itself, no
 * longer a hand-rolled gate). Skips gracefully if the DB is unreachable.
 */

async function dbReachable(db: Container["db"]): Promise<boolean> {
  try {
    await db.select({ id: user.id }).from(user).limit(1);
    return true;
  } catch {
    return false;
  }
}

// --- Public sign-up is closed for everyone -------------------------------

describe("public sign-up is disabled (disableSignUp)", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let reachable = false;
  const createdEmails: string[] = [];

  beforeEach(async () => {
    container = createHogsendClient();
    app = createApp(container);
    reachable = await dbReachable(container.db);
  });

  afterEach(async () => {
    if (!reachable) return;
    for (const email of createdEmails) {
      await container.db.delete(user).where(eq(user.email, email));
    }
    createdEmails.length = 0;
    await container.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("rejects POST /api/auth/sign-up/email with 400 for anyone", async () => {
    if (!reachable) {
      console.warn("test DB unreachable; skipping sign-up disabled assertion");
      return;
    }
    const email = `signup-disabled-${randomUUID()}@example.test`;
    createdEmails.push(email);

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": email },
      body: JSON.stringify({ email, password: "supersecret123", name: "X" }),
    });

    // better-auth's in-handler disableSignUp guard → 400 BAD_REQUEST.
    expect(res.status).toBe(400);
    const body = await res.json();
    const payload = JSON.stringify(body);
    expect(payload).toContain("EMAIL_PASSWORD_SIGN_UP_DISABLED");

    // The cardinal invariant: no user row was created by the network call.
    const rows = await container.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    expect(rows).toHaveLength(0);
  });

  it("rejects sign-up even with a stray setup-token header (no gate left)", async () => {
    if (!reachable) return;
    const email = `signup-disabled-hdr-${randomUUID()}@example.test`;
    createdEmails.push(email);

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hogsend-setup-token": "anything-at-all",
        "x-forwarded-for": email,
      },
      body: JSON.stringify({ email, password: "supersecret123", name: "X" }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    );
  });
});

// --- Env bootstrap: mint-on-zero-users, idempotent -----------------------

describe("bootstrapAdminFromEnv", () => {
  let container: Container;
  let reachable = false;
  const bootstrapEmail = `bootstrap-${randomUUID()}@example.test`;

  beforeEach(async () => {
    container = createHogsendClient();
    reachable = await dbReachable(container.db);
  });

  afterEach(async () => {
    if (!reachable) return;
    await container.db
      .delete(user)
      .where(eq(user.email, bootstrapEmail.toLowerCase()))
      .catch(() => {});
    await container.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("no-ops when STUDIO_ADMIN_EMAIL is unset", async () => {
    if (!reachable) return;
    (container.env as { STUDIO_ADMIN_EMAIL?: string }).STUDIO_ADMIN_EMAIL =
      undefined;
    const before = await container.db.select({ id: user.id }).from(user);
    await bootstrapAdminFromEnv({ client: container });
    const after = await container.db.select({ id: user.id }).from(user);
    expect(after.length).toBe(before.length);
  });

  it("mints exactly once and is idempotent on re-run", async () => {
    if (!reachable) {
      console.warn("test DB unreachable; skipping env bootstrap assertion");
      return;
    }
    // Ensure a clean slate for THIS email (the table may hold rows from other
    // suites, so bootstrap only mints when zero rows exist globally — we assert
    // idempotency on a fresh DB by zero-checking first).
    const existing = await container.db.select({ id: user.id }).from(user);
    if (existing.length > 0) {
      console.warn(
        "users already present; bootstrap is a no-op by design — verifying that",
      );
      const env = container.env as {
        STUDIO_ADMIN_EMAIL?: string;
        STUDIO_ADMIN_PASSWORD?: string;
      };
      env.STUDIO_ADMIN_EMAIL = bootstrapEmail;
      env.STUDIO_ADMIN_PASSWORD = "supersecret123";
      await bootstrapAdminFromEnv({ client: container });
      const minted = await container.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, bootstrapEmail.toLowerCase()));
      // Non-empty DB ⇒ no-op ⇒ our bootstrap email must NOT exist.
      expect(minted).toHaveLength(0);
      return;
    }

    const env = container.env as {
      STUDIO_ADMIN_EMAIL?: string;
      STUDIO_ADMIN_PASSWORD?: string;
    };
    env.STUDIO_ADMIN_EMAIL = bootstrapEmail;
    env.STUDIO_ADMIN_PASSWORD = "supersecret123";

    await bootstrapAdminFromEnv({ client: container });
    const first = await container.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, bootstrapEmail.toLowerCase()));
    expect(first).toHaveLength(1);

    // Re-run: a user now exists ⇒ no-op, still exactly one row.
    await bootstrapAdminFromEnv({ client: container });
    const second = await container.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, bootstrapEmail.toLowerCase()));
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
  });
});
