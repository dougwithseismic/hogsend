import type { ResolvePolicy } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — the resolver never pushes, but the container
// needs a handle and a live engine must never be reached from a unit suite.
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const { contactAliases, contacts } = await import("@hogsend/db");
const { and, eq, inArray, isNull, like, or } = await import("drizzle-orm");
const { createHogsendClient, resolveContactNoCreate, resolveOrCreateContact } =
  await import("@hogsend/engine");

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

// PRD 06 T2 — the differential equivalence harness. T1 made the resolver
// accept two ways of declaring trust: the legacy fields
// (`restrictToAnonymous`, the entry-point split for `allowCreate`) and the new
// `policy: ResolvePolicy`. This file is the PROOF they are equivalent: every
// cell of {create × allowMerge × key shape × fixture} runs the LEGACY shape
// and the POLICY shape against identically-seeded (but separately-namespaced)
// fixtures and asserts identical normalized outcomes — id token, resolvedKey,
// created/linked/merged, mergedKeys, mergedIdentifiedKeys, thrown error
// constructor+message, and the namespace-scoped net live `contacts` row delta.
//
// NAMESPACING IS A HARD REQUIREMENT, NOT HYGIENE (PRD 06 A4). This harness
// deliberately seeds colliding and identified rows. On a reused database an
// un-namespaced run 2's "no row" cells would silently resolve run 1's contacts
// — and because BOTH legs resolve the same stale rows, deep equality would
// still PASS: a fake equivalence proof that is green rather than red, in the
// one test that is the evidentiary basis of the whole PRD (the buckets.test.ts
// defect class, fixed in c3582ce0). So every identity value is run-namespaced
// AND cell+leg-namespaced, and every row assertion is scoped to its own
// namespace — never a whole-table count.
//
// The differential compare alone cannot catch a SYMMETRIC break (both shapes
// normalize into one internal policy, so breaking the shared derivation breaks
// both legs identically). Each cell therefore ALSO asserts an absolute
// expected-arm oracle (throw-clamp / throw-d8 / refuse / create / link /
// merge) derived independently from the cell's coordinates — the anti-vacuity
// teeth.
const RUN = `poleq-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const ALL_KINDS: ResolvePolicy["trustedKinds"] = [
  "external",
  "email",
  "anonymous",
  "discord",
];

type CreateOpt = "on-miss" | "refuse-on-miss";
type MergeOpt = "any" | "anonymous-only";
type Shape =
  | "anon-only"
  | "anon+external"
  | "email-only"
  | "external-only"
  | "anon+email"
  | "discord-only";
type Fixture =
  | "none"
  | "own-row"
  | "identified-owner"
  | "collide"
  | "alias-only"
  | "fresh-claim";

interface Cell {
  idx: number;
  create: CreateOpt;
  merge: MergeOpt;
  shape: Shape;
  fixture: Fixture;
  /** Structurally impossible / duplicate cells are skipped, never faked. */
  skip?: string;
}

/** Shapes whose supplied keys include an anonymous id. */
const TWO_KEY = new Set<Shape>(["anon+external", "anon+email"]);
/** Shapes with a refusal-legal highest-precedence key (userId/anonymousId). */
const HAS_STABLE = new Set<Shape>([
  "anon-only",
  "anon+external",
  "external-only",
  "anon+email",
]);
const HAS_EXTERNAL = new Set<Shape>(["anon+external", "external-only"]);

/** Per-leg namespaced identity values. `A/X/E/D` are the SUPPLIED keys;
 * `A0/X0/E0/D0` are fixture-owned values the resolve never supplies. */
function valsFor(p: string) {
  return {
    A: `${p}-anon`,
    X: `${p}-ext`,
    E: `${p}-em@eq.test`,
    D: `${p}-disc`,
    A0: `${p}-anon0`,
    X0: `${p}-ext0`,
    E0: `${p}-em0@eq.test`,
    D0: `${p}-disc0`,
  };
}
type Vals = ReturnType<typeof valsFor>;

interface SeedKeys {
  userId?: string;
  email?: string;
  anonymousId?: string;
  discordId?: string;
}

function suppliedKeys(shape: Shape, v: Vals): SeedKeys {
  switch (shape) {
    case "anon-only":
      return { anonymousId: v.A };
    case "anon+external":
      return { userId: v.X, anonymousId: v.A };
    case "email-only":
      return { email: v.E };
    case "external-only":
      return { userId: v.X };
    case "anon+email":
      return { anonymousId: v.A, email: v.E };
    case "discord-only":
      return { discordId: v.D };
  }
}

/** The shape's PRIMARY key — what own-row/alias-only/collide-row1 seed. For
 * the anon-carrying shapes this is the anon id (the PRD's anon-centric
 * fixtures); for single-key shapes it is that shape's own key. */
function primaryOf(
  shape: Shape,
  v: Vals,
): {
  kind: "external" | "email" | "anonymous" | "discord";
  value: string;
  seed: SeedKeys;
} {
  switch (shape) {
    case "anon-only":
    case "anon+external":
    case "anon+email":
      return { kind: "anonymous", value: v.A, seed: { anonymousId: v.A } };
    case "email-only":
      return { kind: "email", value: v.E, seed: { email: v.E } };
    case "external-only":
      return { kind: "external", value: v.X, seed: { userId: v.X } };
    case "discord-only":
      return { kind: "discord", value: v.D, seed: { discordId: v.D } };
  }
}

/** Live rows owned by this leg's namespace — NEVER a whole-table count (A4). */
async function countLive(p: string): Promise<number> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNull(contacts.deletedAt),
        or(
          like(contacts.anonymousId, `${p}-%`),
          like(contacts.externalId, `${p}-%`),
          like(contacts.email, `${p}-%`),
          like(contacts.discordId, `${p}-%`),
        ),
      ),
    );
  return rows.length;
}

/**
 * Seed one leg's fixture and return the value→token map used to normalize the
 * outcome into leg-independent form. Fixture rows are minted through the
 * resolver itself (production-shaped: columns + alias dual-write), except the
 * alias row of `alias-only`, which is the point of that fixture.
 */
async function seedFixture(
  shape: Shape,
  fixture: Fixture,
  v: Vals,
): Promise<Map<string, string>> {
  const map = new Map<string, string>([
    [v.A, "<A>"],
    [v.X, "<X>"],
    [v.E, "<E>"],
    [v.D, "<D>"],
    [v.A0, "<A0>"],
    [v.X0, "<X0>"],
    [v.E0, "<E0>"],
    [v.D0, "<D0>"],
  ]);
  const seedRow = async (keys: SeedKeys, token: string) => {
    const r = await resolveOrCreateContact({ db, ...keys });
    map.set(r.id, token);
    return r;
  };
  const prim = primaryOf(shape, v);

  switch (fixture) {
    case "none":
      break;
    case "own-row":
      // A row that already owns the supplied primary key via its own column.
      await seedRow(prim.seed, "<row1>");
      break;
    case "identified-owner":
      // An IDENTIFIED row (fixture-owned external id X0) owning the supplied
      // primary key — the clamp's bite target for the anon-only shape.
      // (external-only is skipped upstream: owning the supplied external key
      // IS being identified, so this fixture coincides with own-row there.)
      await seedRow({ userId: v.X0, ...prim.seed }, "<row1>");
      break;
    case "collide": {
      const row1 = await seedRow(prim.seed, "<row1>");
      // Deterministic survivor selection across legs: make row1 strictly
      // older so pickSurvivor's firstSeenAt leg never falls through to the
      // lowest-uuid tie-break (which would differ between the two legs).
      await db
        .update(contacts)
        .set({ firstSeenAt: new Date(Date.now() - 3_600_000) })
        .where(eq(contacts.id, row1.id));
      if (shape === "anon+external") {
        await seedRow({ userId: v.X }, "<row2>");
      } else if (shape === "anon+email") {
        await seedRow({ email: v.E }, "<row2>");
      } else {
        // Single-key shapes: one supplied key resolves at most ONE contact,
        // so a collide-MERGE is unreachable by construction (the guard note
        // at the clamp's merge arm in contacts.ts). Row2 is an unrelated
        // identified row proving the resolve neither touches nor merges it —
        // the cell lands in fill-in-link on row1 and is asserted as such.
        await seedRow({ userId: v.X0 }, "<row2>");
      }
      break;
    }
    case "alias-only": {
      // MANDATORY post-PRD-03 fixture 1: a contact whose COLUMN key is a
      // different value (A0-style) but which holds the supplied primary key
      // as an ALIAS row only. Drives the alias-first findByKey probe and the
      // claim "held" path of claimIdentityKey under both option shapes.
      const c = await seedRow({ anonymousId: v.A0 }, "<row1>");
      await db.insert(contactAliases).values({
        contactId: c.id,
        aliasKind: prim.kind,
        aliasValue: prim.value,
        fromContactId: null,
        reason: "promote",
      });
      break;
    }
    case "fresh-claim":
      // MANDATORY post-PRD-03 fixture 2: a row whose column anon id differs
      // (A0) while the SUPPLIED anon id is fresh. For the two-key shapes the
      // resolve hits via the other key and the fresh anon id drives claim
      // "claimed" → the adoption loop. For single-key shapes the fresh key
      // simply misses (create/refuse) — the adoption loop is unreachable
      // there, and the fixture row doubles as an untouched-neighbor probe.
      switch (shape) {
        case "anon-only":
          await seedRow({ anonymousId: v.A0 }, "<row1>");
          break;
        case "anon+external":
          await seedRow({ userId: v.X, anonymousId: v.A0 }, "<row1>");
          break;
        case "anon+email":
          await seedRow({ email: v.E, anonymousId: v.A0 }, "<row1>");
          break;
        case "email-only":
          await seedRow({ email: v.E0 }, "<row1>");
          break;
        case "external-only":
          await seedRow({ userId: v.X0 }, "<row1>");
          break;
        case "discord-only":
          await seedRow({ discordId: v.D0 }, "<row1>");
          break;
      }
      break;
  }
  return map;
}

interface RawResult {
  id: string | null;
  resolvedKey: string;
  created: boolean;
  linked: boolean;
  merged: boolean;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
}

interface NormalizedOutcome {
  threw: { name: string; message: string } | null;
  delta: number;
  id?: string | null;
  resolvedKey?: string;
  created?: boolean;
  linked?: boolean;
  merged?: boolean;
  mergedKeys?: string[];
  mergedIdentifiedKeys?: string[];
}

/** Rewrite every concrete (leg-namespaced) value into a symbolic token so the
 * two legs' outcomes are directly deep-comparable. An unmapped value keeps its
 * raw (namespaced) form — which can never match across legs, so any leak
 * fails loudly instead of comparing vacuously. */
function normalize(
  raw: {
    threw: { name: string; message: string } | null;
    result: RawResult | null;
  },
  delta: number,
  map: Map<string, string>,
): NormalizedOutcome {
  if (raw.threw || !raw.result) {
    return { threw: raw.threw, delta };
  }
  const r = raw.result;
  const tok = (value: string): string => {
    const mapped = map.get(value);
    if (mapped) return mapped;
    if (r.id !== null && value === r.id) return "<minted>";
    return `<unmapped:${value}>`;
  };
  return {
    threw: null,
    delta,
    id: r.id === null ? null : tok(r.id),
    resolvedKey: tok(r.resolvedKey),
    created: r.created,
    linked: r.linked,
    merged: r.merged,
    mergedKeys: r.mergedKeys ? [...r.mergedKeys].map(tok).sort() : undefined,
    mergedIdentifiedKeys: r.mergedIdentifiedKeys
      ? [...r.mergedIdentifiedKeys].map(tok).sort()
      : undefined,
  };
}

/** Run ONE leg of a cell in its own namespace: seed the fixture, resolve via
 * the leg's option shape, record the normalized outcome + scoped row delta. */
async function runLeg(cell: Cell, leg: "a" | "b"): Promise<NormalizedOutcome> {
  const p = `${RUN}-c${cell.idx}${leg}`;
  const v = valsFor(p);
  const map = await seedFixture(cell.shape, cell.fixture, v);
  const pre = await countLive(p);

  const keys = suppliedKeys(cell.shape, v);
  const trust =
    leg === "a"
      ? // LEGACY shape: the clamp via `restrictToAnonymous`, the create policy
        // via WHICH entry point is called (the pre-T1 vocabulary, verbatim).
        cell.merge === "anonymous-only"
        ? { restrictToAnonymous: true as const }
        : {}
      : // POLICY shape: the exact object T1's normalization derives from the
        // legacy fields (trustedKinds = all four, the legacy implicit grant).
        {
          policy: {
            create: cell.create,
            allowMerge: cell.merge,
            trustedKinds: ALL_KINDS,
          } satisfies ResolvePolicy,
        };

  let threw: { name: string; message: string } | null = null;
  let result: RawResult | null = null;
  try {
    result =
      cell.create === "on-miss"
        ? await resolveOrCreateContact({ db, ...keys, ...trust })
        : await resolveContactNoCreate({ db, ...keys, ...trust });
  } catch (err) {
    const e = err as Error;
    threw = { name: e.constructor.name, message: e.message };
  }

  const post = await countLive(p);
  return normalize({ threw, result }, post - pre, map);
}

type Arm = "throw-d8" | "throw-clamp" | "refuse" | "create" | "link" | "merge";

/** The absolute oracle: which resolver arm this cell must land in, derived
 * from the cell coordinates alone (independently of the resolver). */
function expectedArm(cell: Cell): Arm {
  // The D8 precondition is STATIC over the supplied shape: an email-only /
  // discord-only refusal throws before resolution, even when a live row owns
  // the supplied key (email/discord are never canonical, so a refusal there
  // would key history on a row uuid that was never minted).
  if (cell.create === "refuse-on-miss" && !HAS_STABLE.has(cell.shape)) {
    return "throw-d8";
  }
  const hits =
    cell.fixture === "own-row" ||
    cell.fixture === "identified-owner" ||
    cell.fixture === "collide" ||
    cell.fixture === "alias-only" ||
    (cell.fixture === "fresh-claim" && TWO_KEY.has(cell.shape));
  if (!hits) {
    return cell.create === "refuse-on-miss" ? "refuse" : "create";
  }
  if (cell.fixture === "collide" && TWO_KEY.has(cell.shape)) return "merge";
  // The clamp bites only when the supplied kinds are EXACTLY one anonymous
  // key AND the single resolved row carries an identified key.
  const clamped = cell.merge === "anonymous-only" && cell.shape === "anon-only";
  if (clamped && cell.fixture === "identified-owner") return "throw-clamp";
  return "link";
}

function assertArm(cell: Cell, norm: NormalizedOutcome): void {
  switch (expectedArm(cell)) {
    case "throw-d8":
      expect(norm.threw?.name).toBe("Error");
      expect(norm.threw?.message).toContain("requires userId or anonymousId");
      expect(norm.delta).toBe(0);
      break;
    case "throw-clamp":
      expect(norm.threw?.name).toBe("PublishableAnonymousMergeError");
      expect(norm.delta).toBe(0);
      break;
    case "refuse":
      expect(norm.threw).toBeNull();
      expect(norm.id).toBeNull();
      expect(norm.created).toBe(false);
      expect(norm.linked).toBe(false);
      expect(norm.merged).toBe(false);
      expect(norm.delta).toBe(0);
      // The refusal key is DERIVED (`userId ?? anonymousId`), never supplied.
      expect(norm.resolvedKey).toBe(
        HAS_EXTERNAL.has(cell.shape) ? "<X>" : "<A>",
      );
      break;
    case "create":
      expect(norm.threw).toBeNull();
      expect(norm.created).toBe(true);
      expect(norm.id).toBe("<minted>");
      expect(norm.delta).toBe(1);
      break;
    case "link":
      expect(norm.threw).toBeNull();
      expect(norm.created).toBe(false);
      expect(norm.linked).toBe(true);
      expect(norm.merged).toBe(false);
      expect(norm.id).toBe("<row1>");
      expect(norm.delta).toBe(0);
      break;
    case "merge":
      expect(norm.threw).toBeNull();
      expect(norm.created).toBe(false);
      expect(norm.linked).toBe(true);
      expect(norm.merged).toBe(true);
      expect(norm.delta).toBe(-1); // the loser is soft-deleted
      if (cell.shape === "anon+external") {
        // Identified row2 survives; the anon loser's key is safely absorbed.
        expect(norm.id).toBe("<row2>");
        expect(norm.resolvedKey).toBe("<X>");
        expect(norm.mergedKeys).toEqual(["<A>"]);
        expect(norm.mergedIdentifiedKeys).toBeUndefined();
      } else {
        // anon+email: neither row identified → the (backdated) older row1
        // survives; the email-only loser's canonical key was its row uuid.
        expect(norm.id).toBe("<row1>");
        expect(norm.resolvedKey).toBe("<A>");
        expect(norm.mergedKeys).toEqual(["<row2>"]);
      }
      break;
  }
}

const CREATES: CreateOpt[] = ["on-miss", "refuse-on-miss"];
const MERGES: MergeOpt[] = ["any", "anonymous-only"];
const SHAPES: Shape[] = [
  "anon-only",
  "anon+external",
  "email-only",
  "external-only",
  "anon+email",
  "discord-only",
];
const FIXTURES: Fixture[] = [
  "none",
  "own-row",
  "identified-owner",
  "collide",
  "alias-only",
  "fresh-claim",
];

const cells: Cell[] = [];
{
  let idx = 0;
  for (const create of CREATES) {
    for (const merge of MERGES) {
      for (const shape of SHAPES) {
        for (const fixture of FIXTURES) {
          idx += 1;
          const skip =
            shape === "external-only" && fixture === "identified-owner"
              ? "identified-owner ≡ own-row for external-only: owning the " +
                "supplied external key IS being identified"
              : undefined;
          cells.push({ idx, create, merge, shape, fixture, skip });
        }
      }
    }
  }
}

// Anti-reuse self-check affordance (A4): HOGSEND_EQ_SKIP_CLEANUP=1 leaves this
// run's namespaced rows in place so a second run can prove it passes against a
// database still holding a prior run's colliding/identified fixtures.
afterAll(async () => {
  if (process.env.HOGSEND_EQ_SKIP_CLEANUP === "1") return;
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
        like(contacts.discordId, `${RUN}-%`),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await db
    .delete(contactAliases)
    .where(
      or(
        inArray(contactAliases.contactId, ids),
        inArray(contactAliases.fromContactId, ids),
      ),
    );
  await db.delete(contacts).where(inArray(contacts.id, ids));
});

describe("resolve policy ≡ legacy fields — differential equivalence (PRD 06 T2)", () => {
  for (const cell of cells) {
    const title =
      `${cell.create} × ${cell.merge} × ${cell.shape} × ${cell.fixture}` +
      (cell.skip ? ` → SKIP: ${cell.skip}` : ` → ${expectedArm(cell)}`);
    if (cell.skip) {
      it.skip(title, () => {});
      continue;
    }
    it(title, async () => {
      const legacy = await runLeg(cell, "a");
      const policy = await runLeg(cell, "b");
      // Absolute oracle first (anti-vacuity: a symmetric resolver break makes
      // both legs wrong IDENTICALLY, which pure deep-equality cannot see).
      assertArm(cell, legacy);
      // The differential proof: byte-identical normalized outcomes.
      expect(policy).toEqual(legacy);
    });
  }

  it("control: the recorder separates a clamped refusal from an unclamped link — the deep-equality assertion is falsifiable", async () => {
    const clamped = await runLeg(
      {
        idx: 9001,
        create: "on-miss",
        merge: "anonymous-only",
        shape: "anon-only",
        fixture: "identified-owner",
      },
      "a",
    );
    const open = await runLeg(
      {
        idx: 9002,
        create: "on-miss",
        merge: "any",
        shape: "anon-only",
        fixture: "identified-owner",
      },
      "a",
    );
    expect(clamped.threw?.name).toBe("PublishableAnonymousMergeError");
    expect(open.threw).toBeNull();
    expect(open.linked).toBe(true);
    expect(clamped).not.toEqual(open);
  });
});

describe("T1 contract guards (pinned)", () => {
  it("resolveOrCreateContact throws on a refuse-on-miss policy and mints nothing", async () => {
    const p = `${RUN}-g1`;
    await expect(
      resolveOrCreateContact({
        db,
        anonymousId: `${p}-anon`,
        policy: {
          create: "refuse-on-miss",
          allowMerge: "any",
          trustedKinds: ALL_KINDS,
        },
      }),
    ).rejects.toThrow(/create-on-miss by contract/);
    expect(await countLive(p)).toBe(0);
  });

  it("resolveContactNoCreate throws on an on-miss policy and mints nothing", async () => {
    const p = `${RUN}-g2`;
    await expect(
      resolveContactNoCreate({
        db,
        anonymousId: `${p}-anon`,
        policy: {
          create: "on-miss",
          allowMerge: "any",
          trustedKinds: ALL_KINDS,
        },
      }),
    ).rejects.toThrow(/refuse-on-miss/);
    expect(await countLive(p)).toBe(0);
  });

  it("supplying both a policy and a legacy field throws — no precedence rule ever ships", async () => {
    const p = `${RUN}-g3`;
    await expect(
      resolveOrCreateContact({
        db,
        anonymousId: `${p}-anon`,
        restrictToAnonymous: true,
        policy: {
          create: "on-miss",
          allowMerge: "anonymous-only",
          trustedKinds: ALL_KINDS,
        },
      }),
    ).rejects.toThrow(/never both/);
    expect(await countLive(p)).toBe(0);
  });
});
