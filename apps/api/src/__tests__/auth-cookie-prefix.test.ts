import { describe, expect, it, vi } from "vitest";

// The vitest config points DATABASE_URL at :5432; the migrated test DB lives at
// :5434. Override before importing the engine (mirrors auth-secondary-storage).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

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

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { createAuth, createHogsendClient } = await import("@hogsend/engine");

// A real (unconnected) drizzle DB is enough for `auth.$context` to resolve the
// cookie config — the assertions never touch a query, just the resolved names.
// Mirrors how auth-secondary-storage.test.ts exercises `$context`.
const { createDatabase } = await import("@hogsend/db");
const { db } = createDatabase({
  url: "postgresql://growthhog:growthhog@localhost:5434/growthhog",
});

const baseAuthOpts = {
  db,
  secret: "test-secret-for-vitest-minimum-32-characters-long",
  // http baseURL → Better Auth applies NO `__Secure-` prefix, so the resolved
  // name is the bare `<prefix>.session_token` (prod https would prepend it).
  baseURL: "http://localhost:3002",
};

// The `$context` resolves to Better Auth's inner context (same object the route
// handlers see as `ctx.context`); `authCookies.sessionToken.name` is the exact
// name emitted in the Set-Cookie header. Typed loosely because `authCookies` is
// an internal-ish surface not on the public `$context` type.
// biome-ignore lint/suspicious/noExplicitAny: reach the internal cookie config.
function sessionCookieName(ctx: any): string {
  return ctx.authCookies.sessionToken.name;
}

describe("engine auth cookie namespace (advanced.cookiePrefix)", () => {
  it("defaults to the `hogsend` namespace, NOT Better Auth's `better-auth` default", async () => {
    // The whole bug: the default `better-auth.session_token` name is shared with
    // the course/docs `.hogsend.com` cross-subdomain SSO cookie delivered to the
    // Studio host. Namespacing to `hogsend` is what breaks the collision.
    const auth = createAuth(baseAuthOpts);
    const ctx = await auth.$context;
    expect(sessionCookieName(ctx)).toBe("hogsend.session_token");
    expect(sessionCookieName(ctx)).not.toBe("better-auth.session_token");
  });

  it("honours an explicit cookiePrefix override", async () => {
    const auth = createAuth({ ...baseAuthOpts, cookiePrefix: "custom" });
    const ctx = await auth.$context;
    expect(sessionCookieName(ctx)).toBe("custom.session_token");
  });

  it("the container wires env.AUTH_COOKIE_PREFIX (default `hogsend`) into the engine auth", async () => {
    // Proves the env → container.ts → createAuth plumbing: the real container's
    // auth (no AUTH_COOKIE_PREFIX set in the vitest env) resolves the default.
    const container = createHogsendClient();
    const ctx = await container.auth.$context;
    expect(sessionCookieName(ctx)).toBe("hogsend.session_token");
    expect(sessionCookieName(ctx)).not.toBe("better-auth.session_token");
  });
});
