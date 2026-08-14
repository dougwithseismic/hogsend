import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Same real test DB the engine singletons read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const { linkAccount, unlinkAccount } = await import("@hogsend/engine");
const { accountLinkHooks, setAccountLinkDb } = await import(
  "../account-links.js"
);

const { db } = createDatabase({ url: process.env.DATABASE_URL as string });
setAccountLinkDb(db);

const RUN = `alh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
/** Unique per call: `beforeEach` seeds a fresh contact for every case. */
const uid = (s: string) => `${RUN}-${s}-${++seq}`;
/** Two live Steam pairs on one contact. Steam is `multiple: true`. */
let PAIR_A = "";
let PAIR_B = "";

async function seedContact(): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: uid("ext"), email: `${uid("c")}@example.com` })
    .returning({ id: contacts.id });
  return (row as { id: string }).id;
}

async function propsOf(contactId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ properties: contacts.properties })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  return ((row as { properties: unknown })?.properties ?? {}) as Record<
    string,
    unknown
  >;
}

let contactId: string;

beforeEach(async () => {
  contactId = await seedContact();
  PAIR_A = uid("puid-a");
  PAIR_B = uid("puid-b");
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
});

describe("the consumer account-link hooks (apps/api reference wiring)", () => {
  it("afterLink writes the namespaced scalars, version as a STRING", async () => {
    await accountLinkHooks.afterLink?.({
      provider: "steam",
      contactId,
      identity: { providerUserId: PAIR_A, username: "player_one" },
      // A bigint above Number.MAX_SAFE_INTEGER: it must survive verbatim.
      version: "9007199254740993",
      method: "oauth",
      relink: false,
      at: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    } as any);

    const props = await propsOf(contactId);
    expect(props.steam_user_id).toBe(PAIR_A);
    expect(props.steam_username).toBe("player_one");
    // The exact string, not a rounded number. `parseInt` here is the bug.
    expect(props.steam_link_version).toBe("9007199254740993");
  });

  it("afterLink is idempotent: replaying it leaves the same row", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    const ctx: any = {
      provider: "steam",
      contactId,
      identity: { providerUserId: PAIR_A, username: "player_one" },
      version: "1",
      method: "oauth",
      relink: false,
      at: new Date().toISOString(),
    };
    await accountLinkHooks.afterLink?.(ctx);
    const first = await propsOf(contactId);
    await accountLinkHooks.afterLink?.(ctx);
    expect(await propsOf(contactId)).toEqual(first);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. The keys are namespaced by PROVIDER,
   * not by pair, and Steam is `multiple: true` (neither `steamAccountLink` nor
   * the call sites set it, and both resolve `provider.multiple ?? true`). So a
   * contact can hold two live Steam links, and an unconditional clear in
   * `afterUnlink` wipes the properties while the other link is still live.
   */
  it("afterUnlink keeps the properties while another live link for that provider remains", async () => {
    await linkAccount({
      db,
      provider: "steam",
      providerUserId: PAIR_A,
      contactId,
      method: "oauth",
      identity: { providerUserId: PAIR_A, username: "player_one" },
      // biome-ignore lint/suspicious/noExplicitAny: narrow store input in a test
    } as any);
    await linkAccount({
      db,
      provider: "steam",
      providerUserId: PAIR_B,
      contactId,
      method: "oauth",
      identity: { providerUserId: PAIR_B, username: "player_two" },
      // biome-ignore lint/suspicious/noExplicitAny: narrow store input in a test
    } as any);
    await accountLinkHooks.afterLink?.({
      provider: "steam",
      contactId,
      identity: { providerUserId: PAIR_B, username: "player_two" },
      version: "1",
      method: "oauth",
      relink: false,
      at: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    } as any);

    // Drop ONE of the two pairs, then run the hook the store would run.
    await unlinkAccount({
      db,
      provider: "steam",
      providerUserId: PAIR_A,
      reason: "api",
      // biome-ignore lint/suspicious/noExplicitAny: narrow store input in a test
    } as any);
    await accountLinkHooks.afterUnlink?.({
      provider: "steam",
      contactId,
      providerUserId: PAIR_A,
      version: "2",
      reason: "api",
      at: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    } as any);

    // PAIR_B is still live, so the namespace must survive.
    expect((await propsOf(contactId)).steam_user_id).toBe(PAIR_B);
  });

  it("afterUnlink clears once the provider's last live link is gone", async () => {
    await linkAccount({
      db,
      provider: "steam",
      providerUserId: PAIR_A,
      contactId,
      method: "oauth",
      identity: { providerUserId: PAIR_A, username: "player_one" },
      // biome-ignore lint/suspicious/noExplicitAny: narrow store input in a test
    } as any);
    await accountLinkHooks.afterLink?.({
      provider: "steam",
      contactId,
      identity: { providerUserId: PAIR_A, username: "player_one" },
      version: "1",
      method: "oauth",
      relink: false,
      at: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    } as any);
    expect((await propsOf(contactId)).steam_user_id).toBe(PAIR_A);

    await unlinkAccount({
      db,
      provider: "steam",
      providerUserId: PAIR_A,
      reason: "api",
      // biome-ignore lint/suspicious/noExplicitAny: narrow store input in a test
    } as any);
    await accountLinkHooks.afterUnlink?.({
      provider: "steam",
      contactId,
      providerUserId: PAIR_A,
      version: "2",
      reason: "api",
      at: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: hook ctx shape is engine-owned
    } as any);

    const props = await propsOf(contactId);
    expect(props.steam_user_id).toBeUndefined();
    expect(props.steam_link_version).toBeUndefined();
  });
});
