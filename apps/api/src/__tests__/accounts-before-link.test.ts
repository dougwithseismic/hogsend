import type { BeforeLinkContext } from "@hogsend/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { createApp, createHogsendClient, signConnectorState } = engine;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";

/**
 * PRD 07 T7 — `beforeLink` is FAIL-CLOSED, driven through the real route.
 *
 * A throw, a timeout and an explicit `{ allow: false }` are ONE outcome. The
 * assertions that matter are the negative ones: no link row, no contact, no
 * token material — a veto that returns 400 while the write already landed is
 * the failure this file exists to catch.
 */
const RUN = `albl-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const hook: { before?: (ctx: BeforeLinkContext) => unknown } = {};
const steam = fakeAccountLink({ id: "steam", name: "Steam", tokens: true });

const container = createHogsendClient({
  accountLinks: {
    providers: [steam],
    allowedOrigins: ["https://play.example.com"],
    hooks: {
      beforeLink(ctx) {
        return hook.before?.(ctx) as never;
      },
    },
  },
});
const app = createApp(container);

let ipSeq = 0;
const freshIp = () => `${RUN}-${ipSeq++}`;

beforeEach(() => {
  hook.before = undefined;
  steam.calls.handleCallback.length = 0;
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}%`));
  await client.end();
});

async function makeContact(externalId: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

function callback(state: string) {
  return app.request(
    `/v1/accounts/steam/callback?state=${encodeURIComponent(state)}`,
    { headers: { "x-forwarded-for": freshIp() } },
  );
}

function state(over: Record<string, unknown>): string {
  return signConnectorState(
    {
      purpose: "account_link",
      providerId: "steam",
      nonce: uid("nonce"),
      ...over,
    },
    SECRET,
    900,
  );
}

const rowsFor = (providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(eq(linkedAccounts.providerUserId, providerUserId));

describe("beforeLink is fail-closed", () => {
  it("a veto writes no linked_accounts row", async () => {
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({
      providerUserId,
      tokens: { accessToken: "should-never-be-sealed" },
    });
    hook.before = () => ({ allow: false, reason: "banned player" });

    const res = await callback(state({ contactId }));
    expect(res.status).toBe(400);
    expect(await rowsFor(providerUserId)).toHaveLength(0);
  });

  it("a veto persists no token material", async () => {
    // The POSITIVE CONTROL is what makes this non-vacuous: the same provider,
    // the same identity and the same grant DO get sealed when the hook allows.
    // So "no token material" below is the veto talking, not a provider that
    // never had tokens (Steam, in production, has none at all — which is why
    // this asserts against a token-declaring Fake).
    const contactId = await makeContact(uid("ext"));
    const vetoedUserId = uid("steamid");
    const allowedUserId = uid("steamid");
    const tokens = { accessToken: "grant-that-must-not-persist" };

    hook.before = () => ({ allow: false });
    steam.proves({ providerUserId: vetoedUserId, tokens });
    expect((await callback(state({ contactId }))).status).toBe(400);
    // No row at all — the store is never called on a veto, so there is nothing
    // for a token to be sealed INTO.
    expect(await rowsFor(vetoedUserId)).toHaveLength(0);

    hook.before = () => ({ allow: true });
    steam.proves({ providerUserId: allowedUserId, tokens });
    expect((await callback(state({ contactId }))).status).toBe(200);
    const [sealed] = await rowsFor(allowedUserId);
    expect(sealed?.tokens).toBeTruthy();
    // Sealed, not stored: the plaintext grant never reaches the column.
    expect(sealed?.tokens).not.toContain(tokens.accessToken);
  });

  it("a throwing beforeLink vetoes", async () => {
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hook.before = () => {
      throw new Error("consumer policy service is down");
    };

    const res = await callback(state({ contactId }));
    expect(res.status).toBe(400);
    expect(await rowsFor(providerUserId)).toHaveLength(0);
  });

  it("a beforeLink that never resolves vetoes at 5s", async () => {
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hook.before = () =>
      new Promise(() => {
        /* never settles */
      });

    const started = Date.now();
    const res = await callback(state({ contactId }));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(400);
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(15_000);
    expect(await rowsFor(providerUserId)).toHaveLength(0);
  });

  it("a vetoed cold callback creates no contacts row", async () => {
    // This is what pins "the veto runs BEFORE the resolve". A resolve-first
    // implementation leaves a ghost contact behind every rejected link.
    const anonymousId = uid("anon");
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hook.before = () => ({ allow: false });

    const before = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));

    const res = await callback(state({ anonymousId }));
    expect(res.status).toBe(400);

    const after = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.anonymousId, `${RUN}%`));
    expect(after).toHaveLength(before.length);
    expect(
      await db
        .select()
        .from(contacts)
        .where(eq(contacts.anonymousId, anonymousId)),
    ).toHaveLength(0);
    expect(await rowsFor(providerUserId)).toHaveLength(0);
  });

  it("an absent beforeLink allows", async () => {
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hook.before = undefined;

    const res = await callback(state({ contactId }));
    expect(res.status).toBe(200);
    expect(await rowsFor(providerUserId)).toHaveLength(1);
  });

  it("a beforeLink returning void allows", async () => {
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });
    hook.before = () => {
      /* observes only */
    };

    const res = await callback(state({ contactId }));
    expect(res.status).toBe(200);
    expect(await rowsFor(providerUserId)).toHaveLength(1);
  });

  it("a veto refuses the link even when the hook returns allow:false AFTER a real proof", async () => {
    // Non-vacuity control for the whole file: the same proof, same contact,
    // same provider — only the verdict differs, and only the verdict decides.
    const contactId = await makeContact(uid("ext"));
    const providerUserId = uid("steamid");
    steam.proves({ providerUserId });

    hook.before = () => ({ allow: false });
    expect((await callback(state({ contactId }))).status).toBe(400);
    expect(await rowsFor(providerUserId)).toHaveLength(0);

    hook.before = () => ({ allow: true });
    expect((await callback(state({ contactId }))).status).toBe(200);
    expect(await rowsFor(providerUserId)).toHaveLength(1);
  });
});

describe("the accounts routes never invoke an after-hook themselves", () => {
  it("grep: no afterLink/afterUnlink reference under routes/accounts", async () => {
    // DECISIONS §15.4 — the store is the SOLE invoker. A second invocation
    // here would fire every customer hook twice and, because the hooks are
    // documented at-least-once, nothing would fail loudly.
    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(
      new URL(
        "../../../../packages/engine/src/routes/accounts/",
        import.meta.url,
      ),
    );
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(`${dir}${file}`, "utf8");
      // The comments explaining WHY are allowed to name them; a CALL is not.
      expect(source).not.toMatch(/\bafterLink\s*\(/);
      expect(source).not.toMatch(/\bafterUnlink\s*\(/);
      expect(source).not.toMatch(/hooks\?\.\s*after/);
    }
  });
});
