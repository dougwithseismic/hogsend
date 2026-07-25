import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default (DECISIONS §4b).
// Needs schema at migration 0066 (`enrichment_lookups`).
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet: `refineContact`'s final step is a real `ingestEvent`, which
// pushes to Hatchet and recurses through `checkBucketMembership`. The spy stands
// in for a live gRPC engine.
const { enginePushSpy, hatchetMock } = vi.hoisted(() => {
  const push = vi.fn();
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
      })),
      events: { push },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { enginePushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketMemberships, contacts, enrichmentLookups } = await import(
  "@hogsend/db"
);
const { and, eq, like } = await import("drizzle-orm");
const {
  EnrichmentProviderRegistry,
  buildBucketRegistry,
  createHogsendClient,
  defineBucket,
  defineEnrichmentProvider,
  refineContact,
  resetBucketRegistry,
  resetEnrichmentProviders,
  setBucketRegistry,
  setEnrichmentProviders,
} = await import("@hogsend/engine");
type EnrichmentResult = import("@hogsend/core").EnrichmentResult;

const container = createHogsendClient();
const { db } = container;

const RUN = `refine-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${uid(label)}@acme-refine.test`;

// ---------------------------------------------------------------------------
// The deterministic FAKE provider. Every "zero spend" acceptance criterion is
// asserted on `providerCalls` — a counter on this object — never inferred from
// a return value. That is the entire point of the PRD.
// ---------------------------------------------------------------------------

const FULL_RESULT: EnrichmentResult = {
  found: true,
  person: {
    title: "VP of Engineering",
    seniority: "vp",
    department: "engineering",
    linkedinUrl: "https://linkedin.com/in/refine",
    country: "US",
  },
  company: {
    name: "Acme",
    domain: "acme.com",
    industry: "software",
    employeeCount: 250,
    estimatedRevenue: 12_000_000,
    country: "US",
  },
  raw: { vendor: "fake" },
};

let providerCalls = 0;
let respond: () => Promise<EnrichmentResult> = async () => FULL_RESULT;

const fakeProvider = defineEnrichmentProvider({
  meta: { id: "fake-enrich", name: "Fake enrichment" },
  capabilities: { personLookup: true, companyLookup: true },
  enrichPerson: async () => {
    providerCalls += 1;
    return respond();
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedContact(
  label: string,
  properties: Record<string, unknown> = {},
): Promise<{ userId: string; email: string }> {
  const userId = uid(label);
  const email = mail(label);
  await db
    .insert(contacts)
    .values({ externalId: userId, email, properties })
    .onConflictDoNothing();
  return { userId, email };
}

async function contactProperties(
  userId: string,
): Promise<Record<string, unknown>> {
  const row = await db.query.contacts.findFirst({
    where: eq(contacts.externalId, userId),
  });
  return row?.properties ?? {};
}

async function ledgerRows(lookupKey: string) {
  return db
    .select()
    .from(enrichmentLookups)
    .where(eq(enrichmentLookups.lookupKey, lookupKey));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  enginePushSpy.mockClear();
  providerCalls = 0;
  respond = async () => FULL_RESULT;
  process.env.ENRICHMENT_MONTHLY_LOOKUPS = "0";
  delete process.env.ENRICHMENT_TTL_DAYS;
  setEnrichmentProviders(
    new EnrichmentProviderRegistry([fakeProvider]),
    fakeProvider,
  );
  // The budget cap is a month-to-date COUNT over the ledger, so the rows this
  // file creates must not leak between its own tests.
  //
  // SCOPED, deliberately. An unscoped delete here is a whole-table wipe of the
  // enrichment ledger, and this file's DATABASE_URL fallback is a LIVE stack.
  // That ledger is the Layer-2 exactly-once backstop AND the month-to-date
  // budget accounting, so wiping it silently uncaps vendor spend and destroys
  // dedup — it already clobbered a live drill once. Every lookup key this file
  // creates comes from `uid()`/`mail()`, so the RUN prefix scopes all of them.
  await db
    .delete(enrichmentLookups)
    .where(like(enrichmentLookups.lookupKey, `${RUN}-%`));
});

afterEach(() => {
  resetEnrichmentProviders();
  resetBucketRegistry();
  process.env.ENRICHMENT_MONTHLY_LOOKUPS = "0";
});

afterAll(async () => {
  // Targeted cleanup — everything this file created is RUN-namespaced.
  //
  // SCOPED, deliberately. An unscoped delete here is a whole-table wipe of the
  // enrichment ledger, and this file's DATABASE_URL fallback is a LIVE stack.
  // That ledger is the Layer-2 exactly-once backstop AND the month-to-date
  // budget accounting, so wiping it silently uncaps vendor spend and destroys
  // dedup — it already clobbered a live drill once. Every lookup key this file
  // creates comes from `uid()`/`mail()`, so the RUN prefix scopes all of them.
  await db
    .delete(enrichmentLookups)
    .where(like(enrichmentLookups.lookupKey, `${RUN}-%`));
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.bucketId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

it("AC 1: a first lookup returns refined, writes ONE found ledger row, and merges the canonical keys", async () => {
  const { userId, email } = await seedContact("ac1");

  const result = await refineContact({ userId });

  expect(result.status).toBe("refined");
  expect(providerCalls).toBe(1);

  const rows = await ledgerRows(email);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("found");
  expect(rows[0]?.provider).toBe("fake-enrich");
  expect(rows[0]?.lookupKind).toBe("email");
  expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());

  const props = await contactProperties(userId);
  expect(props).toMatchObject({
    title: "VP of Engineering",
    seniority: "vp",
    department: "engineering",
    linkedin_url: "https://linkedin.com/in/refine",
    country: "US",
    company: "Acme",
    company_domain: "acme.com",
    company_industry: "software",
    company_employees: 250,
    company_revenue: 12_000_000,
    company_country: "US",
  });
  // Provenance rides under one nested object, never as flat sibling keys.
  const enrichment = props.enrichment as { provider?: string; at?: string };
  expect(enrichment.provider).toBe("fake-enrich");
  expect(typeof enrichment.at).toBe("string");
});

it("AC 2: a second lookup inside the TTL returns cached with ZERO provider calls and no new ledger row", async () => {
  const { userId, email } = await seedContact("ac2");

  await refineContact({ userId });
  expect(providerCalls).toBe(1);

  const second = await refineContact({ userId });

  expect(second.status).toBe("cached");
  // The zero-spend assertion is on the COUNTER, not on the return value.
  expect(providerCalls).toBe(1);
  expect(await ledgerRows(email)).toHaveLength(1);
  // The cached verdict hands back the traits the first lookup landed.
  expect(second.properties).toMatchObject({
    title: "VP of Engineering",
    company_employees: 250,
  });
});

it("AC 3: an unexpired not_found row short-circuits with ZERO provider calls", async () => {
  const { userId, email } = await seedContact("ac3");
  respond = async () => ({ found: false, raw: { miss: true } });

  const first = await refineContact({ userId });
  expect(first.status).toBe("not_found");
  expect(providerCalls).toBe(1);
  expect((await ledgerRows(email))[0]?.status).toBe("not_found");

  const second = await refineContact({ userId });

  expect(second.status).toBe("not_found");
  expect(providerCalls).toBe(1);
  expect(await ledgerRows(email)).toHaveLength(1);
});

it("AC 4: force calls the provider and UPDATES the existing ledger row instead of duplicating it", async () => {
  const { userId, email } = await seedContact("ac4");

  await refineContact({ userId });
  const before = (await ledgerRows(email))[0];
  expect(before).toBeDefined();

  // Backdate so the refresh is observable even on a fast clock.
  await db
    .update(enrichmentLookups)
    .set({ refinedAt: new Date(Date.now() - 60_000) })
    .where(eq(enrichmentLookups.id, before?.id ?? ""));

  const forced = await refineContact({ userId, force: true });

  expect(forced.status).toBe("refined");
  expect(providerCalls).toBe(2);

  const after = await ledgerRows(email);
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(before?.id);
  expect(after[0]?.refinedAt.getTime()).toBeGreaterThan(
    Date.now() - 60_000 + 1,
  );
});

it("AC 5: the monthly cap fails closed with ZERO provider calls, even with force", async () => {
  const { userId } = await seedContact("ac5");
  const other = await seedContact("ac5-other");

  process.env.ENRICHMENT_MONTHLY_LOOKUPS = "1";

  // Spend the single allowed lookup on another subject.
  expect((await refineContact({ userId: other.userId })).status).toBe(
    "refined",
  );
  expect(providerCalls).toBe(1);

  const capped = await refineContact({ userId });
  expect(capped).toEqual({ status: "skipped", reason: "budget_exceeded" });
  expect(providerCalls).toBe(1);

  const forced = await refineContact({ userId, force: true });
  expect(forced).toEqual({ status: "skipped", reason: "budget_exceeded" });
  expect(providerCalls).toBe(1);
});

it("AC 6: with no active provider the call skips, spends nothing, and does not throw", async () => {
  const { userId } = await seedContact("ac6");
  setEnrichmentProviders(new EnrichmentProviderRegistry([]), undefined);

  const result = await refineContact({ userId });

  expect(result).toEqual({ status: "skipped", reason: "no_provider" });
  expect(providerCalls).toBe(0);
});

it("AC 6: an unresolvable provider override skips rather than throwing", async () => {
  const { userId } = await seedContact("ac6b");

  const result = await refineContact({ userId, provider: "not-registered" });

  expect(result).toEqual({ status: "skipped", reason: "no_provider" });
  expect(providerCalls).toBe(0);
});

it("AC 7: a provider throw writes an error row, returns provider_error, and does NOT suppress a retry", async () => {
  const { userId, email } = await seedContact("ac7");
  respond = async () => {
    throw new Error("vendor 503");
  };

  const failed = await refineContact({ userId });

  expect(failed).toEqual({ status: "skipped", reason: "provider_error" });
  expect(providerCalls).toBe(1);
  const errorRows = await ledgerRows(email);
  expect(errorRows).toHaveLength(1);
  expect(errorRows[0]?.status).toBe("error");

  // An `error` row is not a paid result — the next call must reach the vendor.
  respond = async () => FULL_RESULT;
  const retried = await refineContact({ userId });

  expect(retried.status).toBe("refined");
  expect(providerCalls).toBe(2);
  const settled = await ledgerRows(email);
  expect(settled).toHaveLength(1);
  expect(settled[0]?.status).toBe("found");
});

it("AC 8 + AC 10: the employee count lands as a JSON NUMBER and flips a gte bucket through ingestEvent", async () => {
  const bucketId = uid("gtm-qualified");
  setBucketRegistry(
    buildBucketRegistry(
      [
        defineBucket({
          meta: {
            id: bucketId,
            name: "GTM qualified",
            enabled: true,
            criteria: (b) => b.prop("company_employees").gte(100),
          },
        }),
      ],
      "*",
    ),
  );

  const { userId } = await seedContact("ac8");

  // Not a member before refinement — the fit trait does not exist yet.
  expect(
    await db.query.bucketMemberships.findFirst({
      where: and(
        eq(bucketMemberships.userId, userId),
        eq(bucketMemberships.bucketId, bucketId),
      ),
    }),
  ).toBeUndefined();

  const result = await refineContact({ userId });
  expect(result.status).toBe("refined");

  // AC 8 — a real JSON number survives the jsonb round-trip.
  const props = await contactProperties(userId);
  expect(typeof props.company_employees).toBe("number");
  expect(props.company_employees).toBe(250);

  // AC 10 — the write went through `ingestEvent`, so bucket membership was
  // re-evaluated synchronously. `resolveOrCreateContact` alone would not have
  // produced this row.
  const membership = await db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
    ),
  });
  expect(membership).toBeDefined();
  expect(
    enginePushSpy.mock.calls.some(
      (call) => call[0] === `bucket:entered:${bucketId}`,
    ),
  ).toBe(true);
});

it("AC 9: an absent result field is omitted from the patch, leaving a stored value intact", async () => {
  const { userId } = await seedContact("ac9", {
    title: "Previously known title",
    plan: "pro",
  });
  respond = async () => ({
    found: true,
    // No `title` this time — and no company at all.
    person: { seniority: "director" },
    raw: {},
  });

  const result = await refineContact({ userId });
  expect(result.status).toBe("refined");
  expect(result.properties).not.toHaveProperty("title");

  const props = await contactProperties(userId);
  // Untouched, NOT deleted: a null would have been stripped by
  // `jsonb_strip_nulls` and taken the key with it.
  expect(props.title).toBe("Previously known title");
  expect(props.seniority).toBe("director");
  expect(props.plan).toBe("pro");
  expect(props).not.toHaveProperty("company");
});

it("fill-if-absent: a vendor fact never overwrites a first-party value, but fills the gaps", async () => {
  // The contact already knows its own title + company (first-party truth). A
  // paid vendor answer that DISAGREES must not clobber them — it only fills the
  // fields the contact was missing, and always records provenance.
  const { userId } = await seedContact("fill", {
    title: "First-party CTO",
    company: "First-party Co",
  });

  const result = await refineContact({ userId });
  expect(result.status).toBe("refined");

  const props = await contactProperties(userId);
  // First-party values survive verbatim, even though the vendor sent different
  // ones (`title: "VP of Engineering"`, `company: "Acme"`).
  expect(props.title).toBe("First-party CTO");
  expect(props.company).toBe("First-party Co");
  // ...and the gaps the contact did NOT have are filled from the vendor.
  expect(props.seniority).toBe("vp");
  expect(props.company_employees).toBe(250);
  expect((props.enrichment as { provider?: string }).provider).toBe(
    "fake-enrich",
  );
});

it("skips with no_lookup_key and zero spend when nothing resolves to an email or domain", async () => {
  const result = await refineContact({ userId: uid("ghost") });

  expect(result).toEqual({ status: "skipped", reason: "no_lookup_key" });
  expect(providerCalls).toBe(0);
});

it("skips with no_lookup_key when the call names no subject at all", async () => {
  // The PURE argument gate — the only thing allowed to short-circuit before the
  // durable memo, because it reads nothing that can change between a run and
  // its replay.
  const result = await refineContact({});

  expect(result).toEqual({ status: "skipped", reason: "no_lookup_key" });
  expect(providerCalls).toBe(0);
});

it("refines a domain-only contact by its company domain", async () => {
  const userId = uid("domain-only");
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      properties: { company_domain: `${uid("dom")}.example` },
    })
    .onConflictDoNothing();

  const result = await refineContact({ userId });

  expect(result.status).toBe("refined");
  expect(providerCalls).toBe(1);
  const rows = await db
    .select()
    .from(enrichmentLookups)
    .where(eq(enrichmentLookups.lookupKind, "domain"));
  expect(rows).toHaveLength(1);
});

it("keys the domain lookup by an externally-supplied domain over the refinement-written company_domain", async () => {
  // REPLAY SAFETY REGRESSION. The domain becomes the `lookupKey`, which becomes
  // the memo `discriminant`. `refineContact` itself writes `company_domain`
  // (from the vendor's canonical domain, which need not equal the one we looked
  // up by), so if it OUTRANKED an externally-supplied domain the memo key would
  // differ between a run and its replay — a positional-journal shift, the same
  // defect class as a conditional `memoize`.
  //
  // The fix is ORDERING: `refine.ts` reads `companyDomain` → `domain` →
  // `company_domain`, so the refinement-written key is only ever the pick when
  // nothing external is present (and fill-if-absent then leaves it untouched, so
  // it is stable). This contact is the shape that would trip a wrong order: a
  // plain `domain` plus a DISAGREEING `company_domain`.
  const userId = uid("domain-replay");
  const original = `${uid("orig")}.example`;
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      properties: {
        domain: original,
        company_domain: `${uid("vendor")}.example`,
      },
    })
    .onConflictDoNothing();

  const result = await refineContact({ userId });
  expect(result.status).toBe("refined");

  const rows = await db
    .select()
    .from(enrichmentLookups)
    .where(eq(enrichmentLookups.lookupKey, original));
  // Keyed by the contact's own `domain`, NOT the vendor-written value. Move
  // `company_domain` BEFORE `domain` in refine.ts's precedence and this fails.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.lookupKind).toBe("domain");
});

// ---------------------------------------------------------------------------
// Regressions for the four defects the adversarial review confirmed
// ---------------------------------------------------------------------------

async function seedDomainContact(
  label: string,
  domain: string,
): Promise<string> {
  const userId = uid(label);
  await db
    .insert(contacts)
    .values({ externalId: userId, properties: { company_domain: domain } })
    .onConflictDoNothing();
  return userId;
}

function registerFitBucket(bucketId: string): void {
  setBucketRegistry(
    buildBucketRegistry(
      [
        defineBucket({
          meta: {
            id: bucketId,
            name: "GTM qualified",
            enabled: true,
            criteria: (b) => b.prop("company_employees").gte(100),
          },
        }),
      ],
      "*",
    ),
  );
}

async function memberOf(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
    ),
  });
}

it("D2: a SECOND contact sharing the lookup key receives the paid traits and enters the fit bucket", async () => {
  // The ledger is keyed by (provider, kind, key) with NO contact dimension, and
  // a `domain` key is shared by every contact at that company. A cache hit must
  // suppress the SPEND, never the outcome — before the fix contact B got
  // `{ status: "cached", properties: {} }`, no ingest, no membership, and no
  // error to tell anyone the loop had silently not closed.
  const bucketId = uid("gtm-qualified-shared");
  registerFitBucket(bucketId);

  const domain = `${uid("shared")}.example`;
  const a = await seedDomainContact("d2-a", domain);
  const b = await seedDomainContact("d2-b", domain);

  expect((await refineContact({ userId: a })).status).toBe("refined");
  expect(providerCalls).toBe(1);
  expect(await memberOf(a, bucketId)).toBeDefined();

  const second = await refineContact({ userId: b });

  expect(second.status).toBe("cached");
  // AC 2 intact: zero spend, ledger row count unchanged.
  expect(providerCalls).toBe(1);
  expect(await ledgerRows(domain)).toHaveLength(1);
  // ...and the loop closed for B too.
  expect(second.properties).toMatchObject({
    company_employees: 250,
    company: "Acme",
  });
  const props = await contactProperties(b);
  expect(props.company_employees).toBe(250);
  expect(await memberOf(b, bucketId)).toBeDefined();
});

it("touch: an already-held fit fact still enters the bucket (write is dropped, touch re-evaluates)", async () => {
  // The torn-write / already-held case. The contact carries a first-party
  // `company_employees` but was never evaluated against the fit bucket. The
  // vendor returns the same number, so fill-if-absent writes NOTHING for it —
  // membership can only form if the touch channel re-evaluates the bucket.
  const bucketId = uid("gtm-qualified-touch");
  registerFitBucket(bucketId);
  const { userId } = await seedContact("touch", { company_employees: 250 });
  expect(await memberOf(userId, bucketId)).toBeUndefined();

  const result = await refineContact({ userId });
  expect(result.status).toBe("refined");

  const props = await contactProperties(userId);
  // The first-party value is untouched (never entered the write patch)...
  expect(props.company_employees).toBe(250);
  // ...and the bucket re-evaluated against live state via the touch channel.
  expect(await memberOf(userId, bucketId)).toBeDefined();
});

it("D3: the cap counts LOOKUPS, so a force loop on ONE key cannot spend past it", async () => {
  // `force` UPDATES the single row for its key rather than inserting, so a cap
  // that counted ROWS counted distinct SUBJECTS — and the refresh path, the
  // only way to re-spend inside the TTL, was the one path it never measured.
  const { userId, email } = await seedContact("d3");
  process.env.ENRICHMENT_MONTHLY_LOOKUPS = "2";

  expect((await refineContact({ userId })).status).toBe("refined");
  expect((await refineContact({ userId, force: true })).status).toBe("refined");
  expect(providerCalls).toBe(2);

  const capped = await refineContact({ userId, force: true });

  expect(capped).toEqual({ status: "skipped", reason: "budget_exceeded" });
  expect(providerCalls).toBe(2);

  const rows = await ledgerRows(email);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.spendCount).toBe(2);
});

it("D4a: a provider outage on an ALREADY-refined key is counted and visible, so the cap still trips", async () => {
  // The error write used to be `onConflictDoNothing`, so for any key that
  // already had a row the failed lookup was recorded nowhere: an outage across
  // a populated contact base billed without limit and moved no counter.
  const { userId, email } = await seedContact("d4a");
  process.env.ENRICHMENT_MONTHLY_LOOKUPS = "3";

  expect((await refineContact({ userId })).status).toBe("refined");
  const seeded = (await ledgerRows(email))[0];
  expect(seeded?.status).toBe("found");

  // Lapse the TTL so every later call reaches the vendor.
  await db
    .update(enrichmentLookups)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(enrichmentLookups.id, seeded?.id ?? ""));

  respond = async () => {
    throw new Error("vendor 503");
  };

  for (const _ of [1, 2]) {
    expect(await refineContact({ userId })).toEqual({
      status: "skipped",
      reason: "provider_error",
    });
  }
  expect(providerCalls).toBe(3);

  // The 4th request is refused: three lookups left the building this month.
  expect(await refineContact({ userId })).toEqual({
    status: "skipped",
    reason: "budget_exceeded",
  });
  expect(providerCalls).toBe(3);

  const rows = await ledgerRows(email);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.spendCount).toBe(3);
  expect(rows[0]?.lastErrorAt).not.toBeNull();
  // The errors never clobbered the paid answer sitting in the row.
  expect(rows[0]?.status).toBe("found");
  expect(rows[0]?.traits).toMatchObject({ company_employees: 250 });
});

it("D4b: a failed ingest returns a verdict instead of throwing, and the retry closes the loop for free", async () => {
  // The ledger row is committed BEFORE the ingest, so an exception escaping
  // here spent the money, killed the caller's journey run, and left the
  // contact permanently mis-qualified behind an armed 90-day cache.
  const bucketId = uid("gtm-qualified-ingest");
  registerFitBucket(bucketId);
  const { userId, email } = await seedContact("d4b");

  enginePushSpy.mockRejectedValueOnce(new Error("hatchet unavailable"));

  const failed = await refineContact({ userId });

  expect(failed).toEqual({ status: "skipped", reason: "ingest_failed" });
  expect(providerCalls).toBe(1);
  const rows = await ledgerRows(email);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("found");
  // The spend is auditable and the answer is kept — the loop just did not close.
  expect(rows[0]?.traits).toMatchObject({ company_employees: 250 });
  expect(await memberOf(userId, bucketId)).toBeUndefined();

  const retried = await refineContact({ userId });

  expect(retried.status).toBe("cached");
  // Free: the stored patch is re-landed from the ledger, no second vendor call.
  expect(providerCalls).toBe(1);
  expect(await memberOf(userId, bucketId)).toBeDefined();
});
