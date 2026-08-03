import assert from "node:assert/strict";
import test from "node:test";
import type { EnrichmentProvider, EnrichmentResult } from "@hogsend/core";
import { assertUniformDurableJournal } from "../journeys/durable-law-harness.js";
import {
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "../journeys/journey-boundary.js";
import {
  type RefineChainDeps,
  type RefineContactOptions,
  type RefineContactResult,
  type RefineEmitInput,
  type RefineTarget,
  refineOutboundDedupeKey,
  runRefineChain,
} from "./refine-chain.js";

// ---------------------------------------------------------------------------
// Harness — a boundary that RECORDS every durable call, and a fake provider
// with a call COUNTER. AC 11 cannot be proved by return values alone: the
// positional-journal law is about which durable calls were issued, in which
// order, so that is what the stub records.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-25T12:00:00.000Z");
const FOUND: EnrichmentResult = {
  found: true,
  person: { title: "CTO", seniority: "c_suite" },
  company: { name: "Acme", employeeCount: 250 },
  raw: { ok: true },
};

/** Every chain call names its subject — the memo key is derived from THIS. */
const SUBJECT: RefineContactOptions = { userId: "u1" };

interface RecordingBoundary {
  boundary: JourneyBoundary;
  /** One entry per durable call, in issuance order. */
  durableCalls: string[];
}

function recordingBoundary(
  currentLabel?: string,
  memoStrategy: "run" | "skip" = "run",
): RecordingBoundary {
  const durableCalls: string[] = [];
  const boundary: JourneyBoundary = {
    stateId: "state-1",
    runAnchor: "run-1",
    currentLabel,
    seenKeys: new Set(),
    seenRecordLabels: new Set(),
    memoize: async (deps, fn) => {
      durableCalls.push(`memoize:${JSON.stringify(deps)}`);
      // "skip" models an eviction-capable engine replaying a recorded value
      // WITHOUT re-entering the closure.
      if (memoStrategy === "skip") {
        return { status: "cached" } as unknown as never;
      }
      return fn();
    },
  };
  return { boundary, durableCalls };
}

interface FakeProvider {
  provider: EnrichmentProvider;
  calls: () => number;
}

function fakeProvider(
  behaviour: "found" | "throw" | "miss" = "found",
): FakeProvider {
  let calls = 0;
  const provider: EnrichmentProvider = {
    meta: { id: "fake", name: "Fake" },
    capabilities: { personLookup: true, companyLookup: true },
    enrichPerson: async () => {
      calls += 1;
      if (behaviour === "throw") throw new Error("vendor 503");
      if (behaviour === "miss") return { found: false, raw: null };
      return FOUND;
    },
  };
  return { provider, calls: () => calls };
}

interface Harness {
  deps: RefineChainDeps;
  providerCalls: () => number;
  ledgerWrites: number;
  ingests: number;
  /** Every outbound `contact.refined` emit, in order. */
  emits: RefineEmitInput[];
  /** The `contactProperties` each `ingest` received, in order. */
  ingested: Record<string, unknown>[];
  /** The `touchProperties` each `ingest` received, in order. */
  touched: (string[] | undefined)[];
}

function harness(overrides: {
  provider?: EnrichmentProvider;
  providerCalls?: () => number;
  ledgerRow?: {
    status: "found" | "not_found" | "error";
    expiresAt: Date;
    traits?: Record<string, unknown> | null;
  };
  monthlyCap?: number;
  usedThisMonth?: number;
  domainOnly?: boolean;
  target?: RefineTarget | null;
  ingest?: () => Promise<void>;
}): Harness {
  const fake = fakeProvider();
  const provider = overrides.provider ?? fake.provider;
  const providerCalls = overrides.providerCalls ?? fake.calls;
  const state = {
    ledgerWrites: 0,
    ingests: 0,
    emits: [] as RefineEmitInput[],
    ingested: [] as Record<string, unknown>[],
    touched: [] as (string[] | undefined)[],
  };

  const deps: RefineChainDeps = {
    provider,
    providerId: provider.meta.id,
    ttlDays: 90,
    monthlyCap: overrides.monthlyCap ?? 0,
    now: () => NOW,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    budgetWindowStart: () => new Date("2026-07-01T00:00:00.000Z"),
    resolveTarget: async () =>
      overrides.target !== undefined
        ? overrides.target
        : overrides.domainOnly
          ? { contactId: "c1", userId: "u1", domain: "acme.com" }
          : {
              contactId: "c1",
              userId: "u1",
              email: "a@acme.com",
            },
    findLedgerRow: async () => overrides.ledgerRow ?? null,
    countLookupsSince: async () => overrides.usedThisMonth ?? 0,
    writeLedgerRow: async () => {
      state.ledgerWrites += 1;
    },
    ingest: async (input) => {
      state.ingests += 1;
      state.ingested.push(input.contactProperties);
      state.touched.push(input.touchProperties);
      if (overrides.ingest) await overrides.ingest();
    },
    emitRefined: (input) => {
      state.emits.push(input);
    },
  };

  return {
    deps,
    providerCalls,
    get ledgerWrites() {
      return state.ledgerWrites;
    },
    get ingests() {
      return state.ingests;
    },
    get emits() {
      return state.emits;
    },
    get ingested() {
      return state.ingested;
    },
    get touched() {
      return state.touched;
    },
  };
}

const unexpired = (
  status: "found" | "not_found" | "error",
  traits?: Record<string, unknown> | null,
) => ({
  status,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  ...(traits !== undefined ? { traits } : {}),
});

async function runInBoundary(
  deps: RefineChainDeps,
  opts: RefineContactOptions = SUBJECT,
  boundaryArgs: Parameters<typeof recordingBoundary> = [],
): Promise<{ result: RefineContactResult; durableCalls: string[] }> {
  const { boundary, durableCalls } = recordingBoundary(...boundaryArgs);
  const result = await runWithJourneyBoundary(boundary, () =>
    runRefineChain(deps, opts),
  );
  return { result, durableCalls };
}

// ---------------------------------------------------------------------------
// AC 11 — THE POSITIONAL-JOURNAL LAW
// ---------------------------------------------------------------------------

test("AC 11: memoize is issued EXACTLY ONCE per invocation, identically, no matter which gate returns", async () => {
  // Six chains that return from six DIFFERENT gates. Refinement is the worst
  // case for the law because TWO live reads want to sit in front of the memo:
  // the ledger gate reads the very row the `refined` path writes at its final
  // step, and resolving the subject reads a `contacts` row that gains an email
  // mid-sleep. Either one, early-returned, diverges on EVERY replay.
  const cached = await runInBoundary(
    harness({ ledgerRow: unexpired("found") }).deps,
  );
  const budget = await runInBoundary(
    harness({ monthlyCap: 5, usedThisMonth: 5 }).deps,
  );
  const refined = await runInBoundary(harness({}).deps);
  const notFoundCached = await runInBoundary(
    harness({ ledgerRow: unexpired("not_found") }).deps,
  );
  const providerError = await runInBoundary(
    harness({ provider: fakeProvider("throw").provider }).deps,
  );
  // The gate the SHIPPED code returned from before the memoize — the whole
  // point of this regression.
  const noLookupKey = await runInBoundary(harness({ target: null }).deps);

  // The verdicts genuinely differ...
  assert.equal(cached.result.status, "cached");
  assert.deepEqual(budget.result, {
    status: "skipped",
    reason: "budget_exceeded",
  });
  assert.equal(refined.result.status, "refined");
  assert.equal(notFoundCached.result.status, "not_found");
  assert.deepEqual(providerError.result, {
    status: "skipped",
    reason: "provider_error",
  });
  assert.deepEqual(noLookupKey.result, {
    status: "skipped",
    reason: "no_lookup_key",
  });

  // ...and yet the durable journal is byte-identical across all six.
  const expected = ['memoize:["journeyRefine:run-1:u1:u1"]'];
  assert.deepEqual(cached.durableCalls, expected);
  assert.deepEqual(budget.durableCalls, expected);
  assert.deepEqual(refined.durableCalls, expected);
  assert.deepEqual(notFoundCached.durableCalls, expected);
  assert.deepEqual(providerError.durableCalls, expected);
  assert.deepEqual(noLookupKey.durableCalls, expected);
});

test("AC 11: the memo key is derived from the nearest wait label, and idempotencyLabel wins", async () => {
  const labelled = await runInBoundary(harness({}).deps, SUBJECT, ["wait:nps"]);
  assert.deepEqual(labelled.durableCalls, [
    'memoize:["journeyRefine:run-1:wait:nps:u1"]',
  ]);

  const explicit = await runInBoundary(harness({}).deps, {
    ...SUBJECT,
    idempotencyLabel: "second-pass",
  });
  assert.deepEqual(explicit.durableCalls, [
    'memoize:["journeyRefine:run-1:second-pass:u1"]',
  ]);
});

test("AC 11: the memo key is derived from the CALLER's arguments, never a resolved contact value", async () => {
  // Same call, three different resolved subjects. The key may not move.
  const expected = ['memoize:["journeyRefine:run-1:u1:u1"]'];
  for (const target of [
    null,
    { contactId: "c1", userId: "u1", domain: "acme.com" },
    { contactId: "c1", userId: "u1", email: "a@acme.com" },
  ] as (RefineTarget | null)[]) {
    const { durableCalls } = await runInBoundary(harness({ target }).deps);
    assert.deepEqual(durableCalls, expected);
  }

  // contactId beats email beats userId, and the email is normalized so a
  // differently-cased argument cannot re-key the memo.
  const byEmail = await runInBoundary(harness({}).deps, {
    email: "  A@Acme.com ",
    userId: "u1",
  });
  assert.deepEqual(byEmail.durableCalls, [
    'memoize:["journeyRefine:run-1:a@acme.com:a@acme.com"]',
  ]);

  const byContactId = await runInBoundary(harness({}).deps, {
    contactId: "c-9",
    email: "a@acme.com",
    userId: "u1",
  });
  assert.deepEqual(byContactId.durableCalls, [
    'memoize:["journeyRefine:run-1:c-9:c-9"]',
  ]);
});

test("D1 variant A: a contact that gains an email between run and replay issues the SAME journal", async () => {
  // The mainstream flow: a journey enrols on an anonymous event, refines (no
  // lookup key yet), then sleeps for three days. The user fills in the trial
  // form during the sleep, so `contacts.email` is promoted. With eviction live
  // the sleep resumes by replaying from the top — and the shipped code issued
  // ZERO memos on the run and ONE on the replay, shifting every later durable
  // call and killing the run.
  const anonymous = harness({ target: null });
  const identified = harness({});

  const run = await runInBoundary(anonymous.deps);
  const replay = await runInBoundary(identified.deps);

  assert.deepEqual(run.result, { status: "skipped", reason: "no_lookup_key" });
  assert.deepEqual(run.durableCalls, replay.durableCalls);
  assert.deepEqual(run.durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("D1 variant B: a domain-only contact that gains an email derives the SAME memo key, so a replay never re-spends", async () => {
  // Same run anchor, same authored call, a subject that upgraded domain→email
  // mid-sleep. The shipped code keyed the memo on the RESOLVED lookup key, so
  // the replay missed the memo, missed the (differently-keyed) ledger row, and
  // charged the vendor twice for one logical refinement.
  const beforeUpgrade = harness({ domainOnly: true });
  const afterUpgrade = harness({});

  const run = await runInBoundary(beforeUpgrade.deps);
  const replay = await runInBoundary(afterUpgrade.deps);
  assert.deepEqual(run.durableCalls, replay.durableCalls);

  // ...and on an eviction-capable engine the replay never re-enters the
  // closure at all: zero provider calls, zero spend.
  const evicting = harness({});
  const { boundary } = recordingBoundary(undefined, "skip");
  await runWithJourneyBoundary(boundary, () =>
    runRefineChain(evicting.deps, SUBJECT),
  );
  assert.equal(evicting.providerCalls(), 0);
});

test("AC 11: an eviction-capable engine replays the RECORDED verdict without re-entering the closure", async () => {
  // `memoStrategy: "skip"` models a live-eviction Hatchet: the closure is never
  // run on the replay, so no resolve, no gate, no provider call, no ledger
  // write, no ingest.
  const h = harness({});
  const { boundary, durableCalls } = recordingBoundary(undefined, "skip");
  const result = await runWithJourneyBoundary(boundary, () =>
    runRefineChain(h.deps, SUBJECT),
  );

  assert.deepEqual(result, { status: "cached" });
  assert.equal(h.providerCalls(), 0);
  assert.equal(h.ledgerWrites, 0);
  assert.equal(h.ingests, 0);
  assert.deepEqual(durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("two refine sites under one wait label collide loudly instead of silently over-deduping", async () => {
  const h = harness({});
  const { boundary } = recordingBoundary("wait:same");

  await runWithJourneyBoundary(boundary, async () => {
    await runRefineChain(h.deps, SUBJECT);
    await assert.rejects(
      runRefineChain(h.deps, SUBJECT),
      /duplicate idempotency key/,
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-ordering behaviour that needs no database
// ---------------------------------------------------------------------------

test("with NO boundary the chain runs directly — zero durable calls, Layer 2 carries it", async () => {
  const h = harness({});
  const result = await runRefineChain(h.deps, SUBJECT);

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.ledgerWrites, 1);
  assert.equal(h.ingests, 1);
});

test("step 0: a call naming no subject at all skips WITHOUT reading the database", async () => {
  const h = harness({});
  let resolves = 0;
  h.deps.resolveTarget = async () => {
    resolves += 1;
    return null;
  };
  const { result, durableCalls } = await runInBoundary(h.deps, {});

  assert.deepEqual(result, { status: "skipped", reason: "no_lookup_key" });
  assert.equal(h.providerCalls(), 0);
  // A PURE argument check — nothing to key from, and no DB read to diverge on.
  assert.equal(resolves, 0);
  assert.deepEqual(durableCalls, []);
});

test("step 2: an unresolvable subject skips INSIDE the memo, so the verdict replays verbatim", async () => {
  const h = harness({ target: null });
  const { result, durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(result, { status: "skipped", reason: "no_lookup_key" });
  assert.equal(h.providerCalls(), 0);
  // The resolve is a LIVE `contacts` read, so its verdict is memo-recorded like
  // every other stateful one — the memoize is still issued.
  assert.deepEqual(durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("AC 6: no active provider skips with zero spend and never throws", async () => {
  const h = harness({});
  h.deps.provider = undefined;
  h.deps.providerId = undefined;
  const { result, durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(result, { status: "skipped", reason: "no_provider" });
  assert.equal(h.providerCalls(), 0);
  assert.deepEqual(durableCalls, []);
});

test("an unexpired `error` ledger row does NOT short-circuit — the vendor is retried", async () => {
  const h = harness({ ledgerRow: unexpired("error") });
  const result = await runRefineChain(h.deps, SUBJECT);

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
});

test("an EXPIRED found row does not short-circuit", async () => {
  const h = harness({
    ledgerRow: {
      status: "found",
      expiresAt: new Date(NOW.getTime() - 1_000),
    },
  });
  const result = await runRefineChain(h.deps, SUBJECT);

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
});

test("force bypasses the ledger gate but NOT the budget cap", async () => {
  const bypass = harness({ ledgerRow: unexpired("found") });
  assert.equal(
    (await runRefineChain(bypass.deps, { ...SUBJECT, force: true })).status,
    "refined",
  );
  assert.equal(bypass.providerCalls(), 1);

  const capped = harness({
    ledgerRow: unexpired("found"),
    monthlyCap: 2,
    usedThisMonth: 2,
  });
  assert.deepEqual(
    await runRefineChain(capped.deps, { ...SUBJECT, force: true }),
    {
      status: "skipped",
      reason: "budget_exceeded",
    },
  );
  assert.equal(capped.providerCalls(), 0);
});

test("a domain-only contact looks up by domain kind", async () => {
  const h = harness({ domainOnly: true });
  const { durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
  assert.equal(h.providerCalls(), 1);
});

// ---------------------------------------------------------------------------
// D2 — a cache hit suppresses SPEND, never the outcome
// ---------------------------------------------------------------------------

test("D2: a cache hit lands the STORED patch on a contact that never received it", async () => {
  // The shared-domain case: contact B hits the row contact A paid for. The
  // ledger has no contact dimension, so "already paid for" says nothing about
  // whether THIS contact has the traits.
  const stored = { title: "CTO", company_employees: 250 };
  const h = harness({
    ledgerRow: unexpired("found", stored),
    target: { contactId: "c2", userId: "u2", domain: "acme.com" },
  });

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.deepEqual(result, { status: "cached", properties: stored });
  // AC 2 is intact — zero spend, no new ledger row...
  assert.equal(h.providerCalls(), 0);
  assert.equal(h.ledgerWrites, 0);
  // ...and yet the loop closed for B.
  assert.equal(h.ingests, 1);
});

test("D2: a cache hit re-runs the ingest even when the contact already holds the traits", async () => {
  // Holding the properties is NOT the same as having been evaluated against the
  // buckets: only the ingest path re-runs `checkBucketMembership`, and a
  // contact can carry the traits with no membership (exactly what a failed
  // ingest leaves behind). So the cached verdict always re-lands.
  const stored = { title: "CTO", company_employees: 250 };
  const h = harness({
    ledgerRow: unexpired("found", stored),
    target: {
      contactId: "c1",
      userId: "u1",
      domain: "acme.com",
      existingProperties: { ...stored },
    },
  });

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.deepEqual(result, { status: "cached", properties: stored });
  assert.equal(h.ingests, 1);
  // The contact already held every fact, so the WRITE patch is empty (nothing
  // first-party is clobbered) — but the ingest still runs and TOUCHES both keys,
  // so bucket membership re-evaluates against live contact state.
  assert.deepEqual(h.ingested, [{}]);
  assert.deepEqual([...(h.touched[0] ?? [])].sort(), [
    "company_employees",
    "title",
  ]);
  assert.equal(h.providerCalls(), 0);
  assert.equal(h.ledgerWrites, 0);
});

test("D2: a legacy row with no stored patch returns cached with an empty patch", async () => {
  const h = harness({ ledgerRow: unexpired("found", null) });

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.deepEqual(result, {
    status: "cached",
    properties: {},
  });
  assert.equal(h.ingests, 0);
  assert.equal(h.providerCalls(), 0);
});

// ---------------------------------------------------------------------------
// Fill-if-absent — a paid answer fills gaps, never overwrites first-party data
// ---------------------------------------------------------------------------

test("fill-if-absent: a fresh lookup fills gaps but never overwrites a first-party value", async () => {
  // FOUND carries title / seniority / company / company_employees. This contact
  // already has a first-party `title` and `company`, so the paid answer must
  // leave those two alone and only fill what was missing.
  const h = harness({
    target: {
      contactId: "c1",
      userId: "u1",
      email: "a@acme.com",
      existingProperties: { title: "First-party VP", company: "First Co" },
    },
  });

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.equal(result.status, "refined");
  // The vendor's FULL answer is still reported on the result...
  assert.equal(result.properties?.title, "CTO");
  // ...but the WRITE patch OMITS the already-held title + company entirely (so
  // the additive merge leaves the live first-party value untouched — atomic, no
  // stale write-back) and carries the vendor's value only for the gaps.
  const landed = h.ingested[0] ?? {};
  assert.equal("title" in landed, false);
  assert.equal("company" in landed, false);
  assert.equal(landed.seniority, "c_suite");
  assert.equal(landed.company_employees, 250);
  assert.ok(landed.enrichment, "provenance always lands");
  // ...yet every returned fact is TOUCHED, so a fit bucket on the already-held
  // title/company still re-evaluates against live contact state.
  assert.deepEqual([...(h.touched[0] ?? [])].sort(), [
    "company",
    "company_employees",
    "seniority",
    "title",
  ]);
  // The outbound reports only the facts that actually CHANGED on this contact.
  assert.deepEqual(h.emits[0]?.traitKeys, ["company_employees", "seniority"]);
});

// ---------------------------------------------------------------------------
// D4b — a failed ingest is a verdict, not an exception
// ---------------------------------------------------------------------------

test("D4b: a failed ingest does not throw out of the chain and does not report success", async () => {
  const h = harness({
    ingest: async () => {
      throw new Error("hatchet unavailable");
    },
  });

  const result = await runRefineChain(h.deps, SUBJECT);

  // The spend is recorded (the vendor answered) but the caller is told the
  // loop did not close — refinement must never fail the journey run.
  assert.deepEqual(result, { status: "skipped", reason: "ingest_failed" });
  assert.equal(h.ledgerWrites, 1);
});

test("D4b: the retry after a failed ingest re-lands the stored patch for FREE", async () => {
  const stored = { title: "CTO" };
  const h = harness({ ledgerRow: unexpired("found", stored) });

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.deepEqual(result, { status: "cached", properties: stored });
  assert.equal(h.providerCalls(), 0);
  assert.equal(h.ingests, 1);
});

// ---------------------------------------------------------------------------
// PRD 08 — the outbound `contact.refined` event
// ---------------------------------------------------------------------------

/**
 * The sorted canonical trait key names FOUND flattens to — NAMES, never values,
 * and FACTS only: the nested `enrichment` provenance is already carried as the
 * envelope's `at` / `provider`, so it is not a trait.
 */
const FOUND_TRAIT_KEYS = ["company", "company_employees", "seniority", "title"];

/** NOW as the dedupe key serializes it. */
const NOW_ISO = NOW.toISOString();

test("AC 1: a `refined` verdict emits contact.refined with the contact key, provider id and trait NAMES", async () => {
  const h = harness({});

  const result = await runRefineChain(h.deps, SUBJECT);

  assert.equal(result.status, "refined");
  assert.equal(h.emits.length, 1);
  assert.deepEqual(h.emits[0], {
    userId: "u1",
    email: "a@acme.com",
    contactId: "c1",
    provider: "fake",
    traitKeys: FOUND_TRAIT_KEYS,
    refinedAt: NOW,
    dedupeKey: `refine:fake:email:a@acme.com:${NOW_ISO}`,
  });

  // The payload carries key NAMES, never the vendor's values: the event says
  // what changed and a subscriber that wants the values reads the contact.
  const emitted = h.emits[0] as RefineEmitInput;
  assert.ok(!JSON.stringify(emitted.traitKeys).includes("CTO"));
  assert.ok(!JSON.stringify(emitted.traitKeys).includes("Acme"));
  // Provenance is NOT a trait — it rides as `provider` / `refinedAt` instead.
  assert.ok(!emitted.traitKeys.includes("enrichment"));
});

test("AC 1: a found-but-empty vendor answer reports NO traits rather than a metadata key", async () => {
  // `flattenTraits` stamps the `enrichment` provenance unconditionally, so if it
  // counted as a trait this payload would claim a change for an answer that told
  // us nothing about the person.
  const empty: EnrichmentProvider = {
    meta: { id: "fake", name: "Fake" },
    capabilities: { personLookup: true, companyLookup: true },
    enrichPerson: async () => ({ found: true, raw: {} }),
  };
  const h = harness({ provider: empty });

  assert.equal((await runRefineChain(h.deps, SUBJECT)).status, "refined");
  assert.deepEqual(h.emits[0]?.traitKeys, []);
});

test("AC 1: a domain-keyed refinement emits with the domain lookup in its dedupe key", async () => {
  const h = harness({ domainOnly: true });

  assert.equal((await runRefineChain(h.deps, SUBJECT)).status, "refined");
  assert.equal(h.emits.length, 1);
  assert.equal(h.emits[0]?.dedupeKey, `refine:fake:domain:acme.com:${NOW_ISO}`);
  // No email on the subject — the key fields carry only what actually resolved.
  assert.equal(h.emits[0]?.email, undefined);
  assert.equal(h.emits[0]?.userId, "u1");
});

test("AC 2: `cached`, `not_found` and `skipped` emit NOTHING — a cache hit is not an event", async () => {
  const cached = harness({
    ledgerRow: unexpired("found", { title: "CTO" }),
  });
  const notFoundCached = harness({ ledgerRow: unexpired("not_found") });
  const notFoundLive = harness({ provider: fakeProvider("miss").provider });
  const noLookupKey = harness({ target: null });
  const noProvider = harness({});
  noProvider.deps.provider = undefined;
  noProvider.deps.providerId = undefined;
  const budget = harness({ monthlyCap: 5, usedThisMonth: 5 });
  const providerError = harness({ provider: fakeProvider("throw").provider });
  const ingestFailed = harness({
    ingest: async () => {
      throw new Error("hatchet unavailable");
    },
  });

  const cases: [string, Harness, string][] = [
    ["cached", cached, "cached"],
    ["not_found (ledger)", notFoundCached, "not_found"],
    ["not_found (live)", notFoundLive, "not_found"],
    ["skipped:no_lookup_key", noLookupKey, "skipped"],
    ["skipped:no_provider", noProvider, "skipped"],
    ["skipped:budget_exceeded", budget, "skipped"],
    ["skipped:provider_error", providerError, "skipped"],
    ["skipped:ingest_failed", ingestFailed, "skipped"],
  ];

  for (const [name, h, expected] of cases) {
    const result = await runRefineChain(h.deps, SUBJECT);
    assert.equal(result.status, expected, name);
    assert.deepEqual(h.emits, [], `${name} must not emit contact.refined`);
  }

  // The control: the SAME harness shape on the genuine path does emit, so the
  // assertions above are not passing for a trivial reason.
  const refined = harness({});
  assert.equal((await runRefineChain(refined.deps, SUBJECT)).status, "refined");
  assert.equal(refined.emits.length, 1);
});

test("AC 3: re-driving the SAME answer recomputes the SAME dedupeKey, so the second delivery is absorbed", async () => {
  // Two independent drives of the same logical refinement — a task retry, or a
  // boundary-less re-run — landing the same answer at the same instant.
  const first = harness({});
  const second = harness({});
  await runRefineChain(first.deps, SUBJECT);
  await runRefineChain(second.deps, SUBJECT);

  assert.equal(first.emits[0]?.dedupeKey, second.emits[0]?.dedupeKey);
  assert.equal(
    first.emits[0]?.dedupeKey,
    refineOutboundDedupeKey({
      provider: "fake",
      lookupKind: "email",
      lookupKey: "a@acme.com",
      refinedAt: NOW,
    }),
  );

  // A DIFFERENT subject is a different key — the dedupe never collapses two
  // real refinements into one delivery.
  const other = harness({
    target: { contactId: "c2", userId: "u2", email: "b@acme.com" },
  });
  await runRefineChain(other.deps, { userId: "u2" });
  assert.notEqual(other.emits[0]?.dedupeKey, first.emits[0]?.dedupeKey);
});

test("AC 3: a genuinely NEW lookup of the same subject is NOT absorbed — the TTL-refresh case", async () => {
  // 90 days on, the TTL expires, the vendor is asked again and reports a new
  // job title. `webhook_deliveries` has a PERMANENT unique (endpointId,
  // dedupeKey) index and nothing ever deletes a delivery row, so a key made
  // only of (provider, kind, key) would silence this refinement forever — the
  // exact event a CRM sync subscriber exists to receive.
  const LATER = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);
  const today = harness({});
  const ninetyDaysOn = harness({});
  ninetyDaysOn.deps.now = () => LATER;

  await runRefineChain(today.deps, SUBJECT);
  await runRefineChain(ninetyDaysOn.deps, SUBJECT);

  assert.notEqual(today.emits[0]?.dedupeKey, ninetyDaysOn.emits[0]?.dedupeKey);
  assert.equal(
    ninetyDaysOn.emits[0]?.dedupeKey,
    `refine:fake:email:a@acme.com:${LATER.toISOString()}`,
  );

  // ...and the instant is serialized stably, not as a locale string.
  assert.match(
    today.emits[0]?.dedupeKey ?? "",
    /:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
});

test("AC 3: a re-drive never reaches the emit anyway — the LEDGER GATE returns `cached` first", async () => {
  // The instant in the key costs nothing on the re-drive side, because the
  // dedupe is not what defends a re-drive. Attempt 2 finds the row attempt 1
  // wrote and returns `cached` (refine-chain.ts step 3), which has no emit at
  // all — so a duplicate delivery needs a concurrent race, not a retry.
  const redrive = harness({
    ledgerRow: unexpired("found", { title: "CTO" }),
  });

  assert.equal((await runRefineChain(redrive.deps, SUBJECT)).status, "cached");
  assert.deepEqual(redrive.emits, []);
});

test("AC 11 holds WITH the emit: the durable journal is identical on every verdict", async () => {
  // The emit sits on the already-decided `refined` verdict inside the gate
  // closure and issues no durable call, so adding it may not move the journal.
  const refined = harness({});
  const cached = harness({ ledgerRow: unexpired("found", { a: 1 }) });
  const notFound = harness({ ledgerRow: unexpired("not_found") });
  const skipped = harness({ target: null });

  const { results } = await assertUniformDurableJournal({
    paths: {
      refined: () => runRefineChain(refined.deps, SUBJECT),
      cached: () => runRefineChain(cached.deps, SUBJECT),
      not_found: () => runRefineChain(notFound.deps, SUBJECT),
      skipped: () => runRefineChain(skipped.deps, SUBJECT),
    },
    expectedJournal: ['memoize:["journeyRefine:run-1:u1:u1"]'],
  });

  assert.equal(results.refined?.status, "refined");
  assert.equal(results.cached?.status, "cached");
  assert.equal(results.not_found?.status, "not_found");
  assert.equal(results.skipped?.status, "skipped");
  assert.equal(refined.emits.length, 1);
  assert.equal(cached.emits.length, 0);
  assert.equal(notFound.emits.length, 0);
  assert.equal(skipped.emits.length, 0);
});
