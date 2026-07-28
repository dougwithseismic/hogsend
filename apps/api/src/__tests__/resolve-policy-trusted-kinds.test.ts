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
const { and, inArray, isNull, like, or, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { createHogsendClient, resolveContactNoCreate, resolveOrCreateContact } =
  engine;

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

// PRD 06 T5 — `trustedKinds` is ARMED: a supplied key whose kind is absent
// from the caller's declared `policy.trustedKinds` throws
// `UntrustedKeyKindError` AFTER the keys array is built and BEFORE any
// advisory lock is taken (and before the transaction opens), so a refused
// call leaves no lock and no `contacts` row behind. The throw is unreachable
// from every route today (the three-legged L3 unreachability proof — gate /
// stamp / L4 full-trust re-emit); this suite drives it DIRECTLY through the
// two exported resolver entry points, which is the only way to reach it.
//
// Every identity value is run-namespaced (A4) and every row assertion is
// scoped to this run's namespace, never a whole-table count.
const RUN = `poltk-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const ALL_KINDS: ResolvePolicy["trustedKinds"] = [
  "external",
  "email",
  "anonymous",
  "discord",
];

/** Live rows owned by this namespace — NEVER a whole-table count (A4). */
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

/** Resolve to the rejection (or null on success) — lets the suite assert on
 * the error's `name` without importing the deliberately-unexported class. */
function captureRejection(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: Error) => e,
  );
}

afterAll(async () => {
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

describe("trustedKinds is armed (PRD 06 T5)", () => {
  it("resolveOrCreateContact throws on an untrusted kind and mints no row", async () => {
    const p = `${RUN}-a`;
    const err = await captureRejection(
      resolveOrCreateContact({
        db,
        userId: `${p}-user`,
        policy: {
          create: "on-miss",
          allowMerge: "any",
          trustedKinds: ["anonymous"],
        },
      }),
    );
    expect(err).not.toBeNull();
    expect(err?.name).toBe("UntrustedKeyKindError");
    expect(err?.message).toContain('identity key kind "external"');
    expect(await countLive(p)).toBe(0);
  });

  it("resolveContactNoCreate throws when ANY supplied kind is untrusted — the trusted anon key does not excuse the email", async () => {
    const p = `${RUN}-b`;
    const err = await captureRejection(
      resolveContactNoCreate({
        db,
        anonymousId: `${p}-anon`,
        email: `${p}-x@example.com`,
        policy: {
          create: "refuse-on-miss",
          allowMerge: "any",
          trustedKinds: ["anonymous"],
        },
      }),
    );
    expect(err).not.toBeNull();
    expect(err?.name).toBe("UntrustedKeyKindError");
    expect(err?.message).toContain('identity key kind "email"');
    expect(await countLive(p)).toBe(0);
  });

  it("a narrow policy whose kinds cover the supplied keys resolves exactly as before (the L5 narrow callers)", async () => {
    const p = `${RUN}-c`;
    const resolved = await resolveOrCreateContact({
      db,
      userId: `${p}-user`,
      email: `${p}-c@example.com`,
      policy: {
        create: "on-miss",
        allowMerge: "any",
        trustedKinds: ["external", "email"],
      },
    });
    expect(resolved.created).toBe(true);
    expect(resolved.resolvedKey).toBe(`${p}-user`);
    expect(await countLive(p)).toBe(1);
  });

  it("no policy ⇒ all four kinds implicitly trusted — every legacy-shape caller (L5 row 27) is unaffected", async () => {
    const p = `${RUN}-d`;
    const resolved = await resolveOrCreateContact({
      db,
      userId: `${p}-user`,
      email: `${p}-d@example.com`,
      anonymousId: `${p}-anon`,
      discordId: `${p}-disc`,
    });
    expect(resolved.created).toBe(true);
    expect(await countLive(p)).toBe(1);
  });

  it("the throw fires BEFORE the advisory lock — an untrusted call never touches the lock the resolver would take", async () => {
    const p = `${RUN}-lock`;
    const userId = `${p}-user`;

    // Session B: take the EXACT xact advisory lock the resolver takes for
    // this key (`hashtext('external:<value>')`) and hold the transaction open.
    let releaseLock!: () => void;
    const hold = new Promise<void>((r) => {
      releaseLock = r;
    });
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((r) => {
      signalAcquired = r;
    });
    const locker = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`external:${userId}`}))`,
      );
      signalAcquired();
      await hold;
    });
    await acquired;

    try {
      // (a) The UNTRUSTED call rejects immediately even though the lock for
      // its key is held by another session. If the trustedKinds check ran
      // AFTER the lock acquisition, this call would block on session B's lock
      // until the suite timeout killed it — a red test, not a slow one.
      const err = await captureRejection(
        resolveOrCreateContact({
          db,
          userId,
          policy: {
            create: "on-miss",
            allowMerge: "any",
            trustedKinds: ["anonymous"],
          },
        }),
      );
      expect(err?.name).toBe("UntrustedKeyKindError");
      expect(await countLive(p)).toBe(0);

      // (b) Control — session B really does hold the very lock the resolver
      // takes for this key: a TRUSTED resolve of the same key BLOCKS until
      // release. Without this, (a) would also pass with a wrong lock key.
      let settled = false;
      const trusted = resolveOrCreateContact({
        db,
        userId,
        policy: {
          create: "on-miss",
          allowMerge: "any",
          trustedKinds: ALL_KINDS,
        },
      }).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      releaseLock();
      await locker;
      const resolved = await trusted;
      expect(resolved.created).toBe(true);
      expect(await countLive(p)).toBe(1);
    } finally {
      releaseLock();
      await locker.catch(() => {});
    }
  });

  // --- REAL narrow-grant canaries --- The enforcement-sensitive sites are
  // the NARROW grants T3/T4 declared, not the full-trust ones. Each is narrow
  // because its call site structurally cannot supply other kinds today (a
  // body schema, a key guard, or a 400 stops it upstream) — so if one of
  // those inputs is ever widened without widening the grant, the throw fires
  // THERE first, looking like an unrelated 500. These two tests pin the real
  // grants verbatim, so the failure is named here first instead.

  it("the real [email] grant (lib/crm-ingest.ts) — the tightest narrow grant — throws the moment that site widens to another kind", async () => {
    // VERBATIM mirror of the policy at lib/crm-ingest.ts (L5 row 20). If the
    // grant there changes, this mirror must be updated consciously.
    const CRM_GRANT: ResolvePolicy = {
      create: "on-miss",
      allowMerge: "any",
      trustedKinds: ["email"],
    };

    // Positive — the shape the site actually supplies today (email only)
    // resolves exactly as before: the grant is NOT narrower than its inputs.
    const p1 = `${RUN}-crm1`;
    const ok = await resolveOrCreateContact({
      db,
      email: `${p1}-crm@example.com`,
      policy: CRM_GRANT,
    });
    expect(ok.created).toBe(true);
    expect(await countLive(p1)).toBe(1);

    // Negative — the widening scenario (a userId plumbed into that call)
    // throws under the same grant, and mints nothing.
    const p2 = `${RUN}-crm2`;
    const err = await captureRejection(
      resolveOrCreateContact({
        db,
        email: `${p2}-crm@example.com`,
        userId: `${p2}-user`,
        policy: CRM_GRANT,
      }),
    );
    expect(err?.name).toBe("UntrustedKeyKindError");
    expect(err?.message).toContain('identity key kind "external"');
    expect(await countLive(p2)).toBe(0);
  });

  it("the real [external, email] grant (import-contacts / admin create / agent subscribe / lists) throws if an anonymousId ever reaches those sites", async () => {
    // VERBATIM mirror of the policy shared by workflows/import-contacts.ts,
    // routes/admin/contacts.ts (create), routes/admin/agent.ts
    // (subscribe/unsubscribe) and routes/lists/index.ts (rows 12-13).
    const SERVER_KEY_GRANT: ResolvePolicy = {
      create: "on-miss",
      allowMerge: "any",
      trustedKinds: ["external", "email"],
    };
    const p = `${RUN}-skg`;
    const err = await captureRejection(
      resolveOrCreateContact({
        db,
        userId: `${p}-user`,
        email: `${p}-skg@example.com`,
        anonymousId: `${p}-anon`,
        policy: SERVER_KEY_GRANT,
      }),
    );
    expect(err?.name).toBe("UntrustedKeyKindError");
    expect(err?.message).toContain('identity key kind "anonymous"');
    expect(await countLive(p)).toBe(0);
  });

  it("UntrustedKeyKindError stays internal — not exported from the engine's public surface", () => {
    expect("UntrustedKeyKindError" in engine).toBe(false);
  });
});
