/**
 * End-to-end integration test for the journey graph admin route.
 *
 * Boots the REAL Hono app (createApp + createHogsendClient) against the LIVE
 * migrated Postgres, with Hatchet mocked out (same pattern as admin-emails).
 * Seeds a journey in the registry + a few journeyStates with currentNodeId
 * values, then GETs /v1/admin/journeys/<id>/graph and asserts:
 *   - the manifest (rich graph) is loaded and rendered
 *   - the mermaid output uses the corrected %%{ init: {...} }%% directive
 *   - the structured graph matches JourneyGraph
 *   - perNode counts join onto nodes via countKey (the WS-4 contract)
 *   - the zod response validates
 *   - a missing manifest falls back to the metadata skeleton
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
process.env.ADMIN_API_KEY = "hsk_test_admin_e2e";

// Mock Hatchet the same way the other admin tests do — the graph route never
// touches Hatchet, but createHogsendClient() constructs the client eagerly.
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

const { journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { randomUUID } = await import("node:crypto");

const container = createHogsendClient();
const app = createApp(container);
const { db, registry } = container;

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JOURNEY_ID = "graph-e2e-test-journey";

// UUIDs for the id column (the schema uses uuid, not text).
const STATE_ID_1 = randomUUID();
const STATE_ID_2 = randomUUID();
const STATE_ID_3 = randomUUID();

// Register a journey meta so registry.get(id) resolves. Use a minimal meta —
// the route reads trigger.event and exitOn for the metadata fallback.
beforeAll(async () => {
  registry.register({
    id: JOURNEY_ID,
    name: "Graph E2E Test",
    enabled: true,
    trigger: { event: "test.trigger" },
    entryLimit: "once",
    suppress: { hours: 1 },
    exitOn: [{ event: "test.exit" }],
  });

  // Seed journey states at various currentNodeId values to exercise the
  // per-node count join. "start" should map to the trigger node; a checkpoint
  // label should map to that checkpoint; a wait label to that wait.
  await db.insert(journeyStates).values([
    {
      id: STATE_ID_1,
      userId: "u1",
      userEmail: "u1@e2e.test",
      journeyId: JOURNEY_ID,
      currentNodeId: "start",
      status: "active",
      entryCount: 1,
    },
    {
      id: STATE_ID_2,
      userId: "u2",
      userEmail: "u2@e2e.test",
      journeyId: JOURNEY_ID,
      currentNodeId: "scored-9",
      status: "waiting",
      entryCount: 1,
    },
    {
      id: STATE_ID_3,
      userId: "u3",
      userEmail: "u3@e2e.test",
      journeyId: JOURNEY_ID,
      currentNodeId: "scored-9",
      status: "waiting",
      entryCount: 1,
    },
  ]);
});

afterAll(async () => {
  await db.delete(journeyStates).where(eq(journeyStates.journeyId, JOURNEY_ID));
});

describe("GET /v1/admin/journeys/:id/graph (integration)", () => {
  it("returns 404 for an unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/does-not-exist/graph", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it("returns the rich graph from the manifest with corrected mermaid + counts", async () => {
    // Write a temp manifest containing our registered test journey, point the
    // loader at it, and reset the cache so it re-reads.
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const tmpDir = resolve(".hogsend-e2e-tmp");
    mkdirSync(tmpDir, { recursive: true });
    const manifestPath = resolve(tmpDir, "journeys.graph.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        journeys: [
          {
            journeyId: JOURNEY_ID,
            sourceLevel: "rich",
            // Source pointer surfaces for the Studio IDE deep links. No
            // sourceHash → detectStale short-circuits (not stale), no disk read.
            sourceFile: "src/journeys/welcome.ts",
            nodes: [
              {
                id: "n1",
                kind: "trigger",
                label: "test.trigger",
                countKey: "start",
              },
              {
                id: "n2",
                kind: "email",
                label: "Welcome",
                detail: "Templates.WELCOME",
                templateRef: "Templates.WELCOME",
                templateKey: "welcome",
                sourceLine: 12,
              },
              {
                id: "n3",
                kind: "checkpoint",
                label: "scored-9",
                countKey: "scored-9",
              },
              { id: "n4", kind: "end", label: "end" },
            ],
            edges: [
              { from: "n1", to: "n2", kind: "main" },
              { from: "n2", to: "n3", kind: "main" },
              { from: "n3", to: "n4", kind: "main" },
            ],
          },
        ],
      }),
    );
    const prevManifest = process.env.HOGSEND_GRAPH_MANIFEST;
    process.env.HOGSEND_GRAPH_MANIFEST = manifestPath;

    const res = await app.request(`/v1/admin/journeys/${JOURNEY_ID}/graph`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // sourceLevel is RICH because the manifest had this journey.
    expect(body.sourceLevel).toBe("rich");

    // The mermaid directive MUST be the corrected form (WS-1.1) — the old
    // bare %%init%% line would fail this assertion.
    expect(body.mermaid).toContain("%%{ init: { themeVariables:");
    expect(body.mermaid).not.toMatch(/^%%init%%$/m);
    expect(body.mermaid).toContain("flowchart TD");

    // Parser-safe: the reserved lowercase `end` never appears as a raw class
    // or annotation, and class names are prefixed (no hyphens mermaid rejects).
    expect(body.mermaid).not.toContain("classDef end ");
    expect(body.mermaid).not.toContain(":::end");
    expect(body.mermaid).not.toMatch(/classDef kind-[a-z]/);

    // Structured graph shape (WS-3.2 zod schema now documents this).
    expect(body.graph.journeyId).toBe(JOURNEY_ID);
    expect(Array.isArray(body.graph.nodes)).toBe(true);
    const kinds = body.graph.nodes.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain("trigger");
    expect(kinds).toContain("email");

    // The trigger node carries countKey "start" (WS-4).
    const trigger = body.graph.nodes.find(
      (n: { kind: string }) => n.kind === "trigger",
    );
    expect(trigger.countKey).toBe("start");

    // Email node passes through the resolved template key + authored ref and
    // the source line (B.1) so Studio can preview + deep-link without guessing.
    const email = body.graph.nodes.find(
      (n: { kind: string }) => n.kind === "email",
    );
    expect(email.templateRef).toBe("Templates.WELCOME");
    expect(email.templateKey).toBe("welcome");
    expect(email.sourceLine).toBe(12);

    // The relative source pointer surfaces for IDE deep links.
    expect(body.graph.sourceFile).toBe("src/journeys/welcome.ts");

    // No two edges are byte-identical (branch de-dup contract holds over the
    // wire, not just in the extractor).
    const dupes = body.graph.edges.filter(
      (
        edge: { from: string; to: string; kind?: string; label?: string },
        i: number,
      ) =>
        body.graph.edges.some(
          (
            other: {
              from: string;
              to: string;
              kind?: string;
              label?: string;
            },
            j: number,
          ) =>
            j !== i &&
            other.from === edge.from &&
            other.to === edge.to &&
            other.kind === edge.kind &&
            other.label === edge.label,
        ),
    );
    expect(dupes).toHaveLength(0);

    // The seeded counts join: 1 at "start", 2 at "scored-9".
    expect(body.counts.perNode.start).toBe(1);
    expect(body.counts.perNode["scored-9"]).toBe(2);

    // Counts object has the documented shape.
    expect(body.counts).toHaveProperty("funnel");
    expect(typeof body.counts.funnel.enrolled).toBe("number");

    // Manifest metadata surfaces: generation timestamp present, and no
    // staleness flagged (this manifest has no sourceFile/sourceHash to check).
    expect(typeof body.generatedAt).toBe("string");
    expect(body.stale).toBe(false);
    expect(body.staleReason).toBeNull();

    // Cleanup + restore.
    process.env.HOGSEND_GRAPH_MANIFEST = prevManifest;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags a stale manifest when the authored source hash drifts", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { resolve, relative } = await import("node:path");
    const tmpDir = resolve(".hogsend-e2e-stale");
    mkdirSync(tmpDir, { recursive: true });

    // A "source file" on disk whose content will NOT match the recorded hash.
    const srcPath = resolve(tmpDir, "journey.ts");
    writeFileSync(srcPath, "// edited after the manifest was generated\n");

    const manifestPath = resolve(tmpDir, "journeys.graph.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        journeys: [
          {
            journeyId: JOURNEY_ID,
            sourceLevel: "rich",
            sourceFile: relative(process.cwd(), srcPath),
            sourceHash: "0".repeat(64), // guaranteed mismatch
            nodes: [
              { id: "n1", kind: "trigger", label: "t", countKey: "start" },
              { id: "n2", kind: "end", label: "end" },
            ],
            edges: [{ from: "n1", to: "n2", kind: "main" }],
          },
        ],
      }),
    );
    const prevManifest = process.env.HOGSEND_GRAPH_MANIFEST;
    process.env.HOGSEND_GRAPH_MANIFEST = manifestPath;

    const res = await app.request(`/v1/admin/journeys/${JOURNEY_ID}/graph`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.staleReason).toContain("journey.ts");

    process.env.HOGSEND_GRAPH_MANIFEST = prevManifest;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("joins perNode counts onto the trigger node via countKey 'start'", async () => {
    // Our seeded states sit at currentNodeId "start" — those counts must
    // appear under counts.perNode["start"], and the trigger node (countKey
    // "start") is where the Studio would badge them.
    const res = await app.request(`/v1/admin/journeys/${JOURNEY_ID}/graph`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // This journey isn't in the manifest → metadata fallback (WS-3 + WS-2.1).
    expect(body.sourceLevel).toBe("metadata");
    // No manifest → no generation timestamp, never stale.
    expect(body.generatedAt).toBeNull();
    expect(body.stale).toBe(false);

    // The 1 seeded "start" state shows up under perNode["start"].
    expect(body.counts.perNode.start).toBe(1);
    // The 2 seeded "scored-9" states show up under perNode["scored-9"].
    expect(body.counts.perNode["scored-9"]).toBe(2);
  });

  it("regenerates the cache when the manifest mtime changes (WS-3.1)", async () => {
    // Write a manifest, read it (primes the cache), bump its mtime, rewrite
    // with different content, read again — the second read must reflect the
    // NEW content (proving the cache invalidated), not a stale copy.
    const { writeFileSync, mkdirSync, rmSync, utimesSync } = await import(
      "node:fs"
    );
    const { resolve } = await import("node:path");
    const tmpDir = resolve(".hogsend-e2e-mtime");
    mkdirSync(tmpDir, { recursive: true });
    const manifestPath = resolve(tmpDir, "journeys.graph.json");

    const writeManifest = (label: string) =>
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          journeys: [
            {
              journeyId: JOURNEY_ID,
              sourceLevel: "rich",
              nodes: [
                { id: "n1", kind: "trigger", label, countKey: "start" },
                { id: "n2", kind: "end", label: "end" },
              ],
              edges: [{ from: "n1", to: "n2", kind: "main" }],
            },
          ],
        }),
      );

    const prevManifest = process.env.HOGSEND_GRAPH_MANIFEST;
    process.env.HOGSEND_GRAPH_MANIFEST = manifestPath;
    writeManifest("first-version");

    // First read primes the cache.
    const res1 = await app.request(`/v1/admin/journeys/${JOURNEY_ID}/graph`, {
      headers: AUTH,
    });
    const body1 = await res1.json();
    expect(body1.graph.nodes[0].label).toBe("first-version");

    // Bump mtime + rewrite. Without mtime invalidation the cache would serve
    // "first-version" forever.
    writeManifest("second-version");
    const future = new Date(Date.now() + 5000);
    utimesSync(manifestPath, future, future);

    const res2 = await app.request(`/v1/admin/journeys/${JOURNEY_ID}/graph`, {
      headers: AUTH,
    });
    const body2 = await res2.json();
    expect(body2.graph.nodes[0].label).toBe("second-version");

    process.env.HOGSEND_GRAPH_MANIFEST = prevManifest;
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
