/**
 * PRD 05 stage 2 - the referral store (`lib/referrals.ts`), against the real
 * local Postgres, the same convention as the other store suites. Every row is
 * namespaced by RUN and swept in `afterAll`; no assertion is a whole-table
 * count.
 *
 * The no-emit law is pinned separately, by source read, in the engine package
 * (`lib/referrals-no-emit.test.ts`) - a behavioural test cannot see a duplicate
 * emit, because the dedupe key would swallow it.
 */
import { afterAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, createDatabase, referralTouches } = await import(
  "@hogsend/db"
);
const { eq, inArray, like } = await import("drizzle-orm");
const { days, defineReferral } = await import("@hogsend/core");
const {
  bindTouches,
  listTouchesForReferee,
  listTouchesForReferrer,
  qualifyTouch,
  recordTouch,
  rejectTouch,
} = await import("@hogsend/engine");

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const RUN = `refstore-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const key = (label: string) => `${RUN}-${label}-${seq++}`;
const REFERRAL_ID = `${RUN}-invite`.slice(0, 64);

const contactIds: string[] = [];

async function makeContact(): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: key("c") })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  contactIds.push(row.id);
  return row.id;
}

const invite = defineReferral({
  id: "invite",
  link: { destination: "https://app.example.com/join" },
  bindWindow: days(30),
});

afterAll(async () => {
  await db
    .delete(referralTouches)
    .where(like(referralTouches.referralId, `${RUN}%`));
  if (contactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  await client.end({ timeout: 5 });
});

/** A `DefinedReferral` carrying the given hooks, under the run's namespace. */
function withHooks(hooks: Parameters<typeof defineReferral>[0]) {
  const def = defineReferral({ ...hooks });
  return { ...def, id: REFERRAL_ID };
}

describe("recordTouch", () => {
  it("records a cold touch as `touched` with no referee contact", async () => {
    const referrer = await makeContact();
    const anon = key("anon");

    const res = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
      clickId: crypto.randomUUID(),
    });

    expect(res.created).toBe(true);
    expect(res.existing).toBe(false);
    expect(res.rejected).toBe(false);
    expect(res.touch.status).toBe("touched");
    expect(res.touch.refereeContactId).toBeNull();
    expect(res.touch.refereeKey).toBe(anon);
  });

  it("binds immediately when the toucher is already identified", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();

    const res = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "manual",
    });

    expect(res.touch.status).toBe("bound");
    expect(res.touch.boundAt).not.toBeNull();
  });

  it("a repeat of the same clickId is a no-op", async () => {
    const referrer = await makeContact();
    const clickId = crypto.randomUUID();
    const anon = key("anon");

    const first = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
      clickId,
    });
    const second = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
      clickId,
    });

    expect(second.created).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.touch.id).toBe(first.touch.id);

    const rows = await db
      .select({ id: referralTouches.id })
      .from(referralTouches)
      .where(eq(referralTouches.clickId, clickId));
    expect(rows).toHaveLength(1);
  });

  it("a repeat of the same explicit idempotencyKey is a no-op", async () => {
    const referrer = await makeContact();
    const idempotencyKey = key("invite-key");

    const first = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("anon"),
      source: "invite",
      idempotencyKey,
    });
    const second = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      // A DIFFERENT key: the idempotency key is the replay identity, so a
      // retry that re-derived the anon id must still be one touch.
      refereeKey: key("anon"),
      source: "invite",
      idempotencyKey,
    });

    expect(second.created).toBe(false);
    expect(second.touch.id).toBe(first.touch.id);
  });

  it("rejects a self-referral by an already-identified toucher", async () => {
    const self = await makeContact();

    const res = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: self,
      refereeKey: key("self"),
      refereeContactId: self,
      source: "link",
    });

    expect(res.rejected).toBe(true);
    expect(res.touch.status).toBe("rejected");
    expect(res.touch.rejectedReason).toBe("self");
    // The refusal is a FACT, not a silence: the row exists so the report and
    // the operator can see the edge was refused, and why.
    expect(res.created).toBe(true);
  });

  it("records a beforeTouch veto with the hook's reason", async () => {
    const referrer = await makeContact();
    const referral = withHooks({
      link: { destination: "https://app.example.com/join" },
      beforeTouch: () => ({ ok: false, reason: "rate_capped" }),
    });

    const res = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("anon"),
      source: "link",
      referral,
    });

    expect(res.rejected).toBe(true);
    expect(res.touch.rejectedReason).toBe("veto");
    expect(res.touch.properties.vetoReason).toBe("rate_capped");
  });

  it("dedupes the same pair on the edge, but allows a different referrer", async () => {
    const referrerA = await makeContact();
    const referrerB = await makeContact();
    const referee = await makeContact();

    const first = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrerA,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "link",
    });
    // The SAME pair again: one pair is one edge, so this must recover the
    // first row rather than double-count the referrer in every report.
    const again = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrerA,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "link",
    });
    expect(again.created).toBe(false);
    expect(again.touch.id).toBe(first.touch.id);

    // A DIFFERENT referrer is a NEW edge - last-touch models can only see an
    // edge that was actually written.
    const other = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrerB,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "link",
    });
    expect(other.created).toBe(true);
    expect(other.touch.id).not.toBe(first.touch.id);

    const seen = await listTouchesForReferee({
      db,
      contactId: referee,
      referralId: REFERRAL_ID,
    });
    expect(seen).toHaveLength(2);
  });
});

describe("bindTouches", () => {
  it("stamps the referee contact and bound_at on an unbound touch", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();
    const anon = key("anon");

    await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
    });

    const res = await bindTouches({ db, refereeKey: anon, contactId: referee });

    expect(res.bound).toHaveLength(1);
    expect(res.bound[0]?.status).toBe("bound");
    expect(res.bound[0]?.refereeContactId).toBe(referee);
    expect(res.bound[0]?.boundAt).not.toBeNull();

    const mine = await listTouchesForReferrer({
      db,
      contactId: referrer,
      referralId: REFERRAL_ID,
    });
    expect(mine).toHaveLength(1);
  });

  it("rejects a touch whose referee turns out to BE the referrer", async () => {
    const self = await makeContact();
    const anon = key("anon");

    await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: self,
      refereeKey: anon,
      source: "link",
    });

    const res = await bindTouches({ db, refereeKey: anon, contactId: self });

    expect(res.bound).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe("self");
    expect(res.rejected[0]?.touch.status).toBe("rejected");
  });

  it("rejects a touch older than the bind window", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();
    const anon = key("anon");

    await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
      // 31 days ago, one day past the default 30-day window.
      touchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });

    const res = await bindTouches({
      db,
      refereeKey: anon,
      contactId: referee,
      resolveReferral: () => ({ ...invite, id: REFERRAL_ID }),
    });

    expect(res.bound).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe("window");
  });

  it("rejects a touch its beforeBind hook vetoes", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();
    const anon = key("anon");

    await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: anon,
      source: "link",
    });

    const referral = withHooks({
      link: { destination: "https://app.example.com/join" },
      beforeBind: async () => ({ ok: false, reason: "disposable_email" }),
    });
    const res = await bindTouches({
      db,
      refereeKey: anon,
      contactId: referee,
      resolveReferral: () => referral,
    });

    expect(res.bound).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe("veto");
    expect(res.rejected[0]?.touch.properties.vetoReason).toBe(
      "disposable_email",
    );
  });

  it("is a no-op for a key with no unbound touches", async () => {
    const referee = await makeContact();
    const res = await bindTouches({
      db,
      refereeKey: key("nothing"),
      contactId: referee,
    });
    expect(res.bound).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
  });
});

describe("qualifyTouch", () => {
  it("promotes a bound touch exactly once", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();

    const touch = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "manual",
    });

    const first = await qualifyTouch({
      db,
      touchId: touch.touch.id,
      event: "subscription.started",
    });
    expect(first.qualified).toBe(true);
    expect(first.touch?.status).toBe("qualified");
    expect(first.touch?.qualifiedAt).not.toBeNull();

    // The replay guard. A redelivered qualify event must NOT re-fire the
    // reward journey downstream.
    const second = await qualifyTouch({
      db,
      touchId: touch.touch.id,
      event: "subscription.started",
    });
    expect(second.qualified).toBe(false);
    expect(second.existing).toBe(true);
  });

  it("refuses to qualify an unbound touch", async () => {
    const referrer = await makeContact();
    const touch = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("anon"),
      source: "link",
    });

    const res = await qualifyTouch({ db, touchId: touch.touch.id });
    expect(res.qualified).toBe(false);
    expect(res.reason).toBe("not_bound");
  });

  it("records a beforeQualify veto as a rejection", async () => {
    const referrer = await makeContact();
    const referee = await makeContact();
    const touch = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: referrer,
      refereeKey: key("known"),
      refereeContactId: referee,
      source: "manual",
    });

    const referral = withHooks({
      link: { destination: "https://app.example.com/join" },
      beforeQualify: () => ({ ok: false, reason: "below_min_value" }),
    });
    const res = await qualifyTouch({
      db,
      touchId: touch.touch.id,
      event: "subscription.started",
      referral,
    });

    expect(res.qualified).toBe(false);
    expect(res.rejected).toBe(true);
    expect(res.touch?.rejectedReason).toBe("veto");
  });
});

describe("rejectTouch", () => {
  it("never rewrites an existing rejection reason", async () => {
    const self = await makeContact();
    const touch = await recordTouch({
      db,
      referralId: REFERRAL_ID,
      referrerContactId: self,
      refereeKey: key("self"),
      refereeContactId: self,
      source: "link",
    });

    const res = await rejectTouch({
      db,
      touchId: touch.touch.id,
      reason: "duplicate",
    });

    expect(res.rejected).toBe(false);
    // The ORIGINAL reason survives: it is the only record of why the edge was
    // thrown away.
    expect(res.touch?.rejectedReason).toBe("self");
  });
});
