import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createApp, createHogsendClient, loadAndRegisterDbSpecs } = await import(
  "@hogsend/engine"
);
const { journeySpecs, journeySpecVersions } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { journeys } = await import("../journeys/index.js");
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

const mockHatchet = {
  durableTask: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const RUN = `adminspec-${Date.now()}`;

function specFor(id: string, name = "Admin CRUD spec") {
  return {
    specVersion: 1,
    id,
    meta: {
      name,
      enabled: true,
      trigger: { event: `${RUN}.trigger` },
      entryLimit: "unlimited",
      suppress: { minutes: 1 },
    },
    steps: [{ id: "note", type: "checkpoint" }],
  };
}

function put(id: string, body: unknown) {
  return app.request(`/v1/admin/journey-specs/${id}`, {
    method: "PUT",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  await db
    .delete(journeySpecVersions)
    .where(like(journeySpecVersions.journeyId, `${RUN}%`));
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
});

describe("admin journey-specs CRUD", () => {
  it("401s without auth", async () => {
    const res = await app.request("/v1/admin/journey-specs");
    expect(res.status).toBe(401);
  });

  it("creates, lists, and re-reads a spec; replace bumps the version", async () => {
    const id = `${RUN}-a`;

    const created = await put(id, specFor(id));
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.created).toBe(true);
    expect(createdBody.spec.version).toBe(1);

    const list = await app.request("/v1/admin/journey-specs", {
      headers: AUTH,
    });
    const listBody = await list.json();
    expect(listBody.specs.some((s: { id: string }) => s.id === id)).toBe(true);

    // Replace → created:false, version bumped.
    const replaced = await put(id, specFor(id, "Renamed"));
    const replacedBody = await replaced.json();
    expect(replacedBody.created).toBe(false);
    expect(replacedBody.spec.version).toBe(2);
    expect(replacedBody.spec.name).toBe("Renamed");

    const one = await app.request(`/v1/admin/journey-specs/${id}`, {
      headers: AUTH,
    });
    expect(one.status).toBe(200);
    const oneBody = await one.json();
    expect(oneBody.spec.id).toBe(id);
    expect(oneBody.summary.version).toBe(2);
  });

  it("rejects a body id that disagrees with the path", async () => {
    const res = await put(`${RUN}-mismatch`, specFor(`${RUN}-other`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/);
  });

  it("rejects an invalid spec (bad shape)", async () => {
    const res = await put(`${RUN}-bad`, { specVersion: 1, id: `${RUN}-bad` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid spec/);
  });

  it("rejects a spec that references a template not in the registry", async () => {
    const id = `${RUN}-deadtpl`;
    const res = await put(id, {
      ...specFor(id),
      steps: [
        {
          id: "hi",
          type: "send_email",
          template: "definitely-not-a-real-template",
          subject: "x",
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/template/i);
  });

  it("refuses an id owned by a code journey (code wins)", async () => {
    // Any id already in the registry with no journey_specs row is code-owned.
    const codeId = container.registry
      .getAll()
      .map((j) => j.id)
      .find(Boolean);
    expect(codeId).toBeTruthy();
    const res = await put(codeId as string, specFor(codeId as string));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/code journe/i);
  });

  it("toggles enabled and deletes", async () => {
    const id = `${RUN}-toggle`;
    await put(id, specFor(id));

    const patched = await app.request(`/v1/admin/journey-specs/${id}`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).spec.enabled).toBe(false);

    const del = await app.request(`/v1/admin/journey-specs/${id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);

    const gone = await app.request(`/v1/admin/journey-specs/${id}`, {
      headers: AUTH,
    });
    expect(gone.status).toBe(404);
  });

  it("404s on patch/delete of a missing spec", async () => {
    const patch = await app.request(`/v1/admin/journey-specs/${RUN}-nope`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(404);

    const del = await app.request(`/v1/admin/journey-specs/${RUN}-nope`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(404);
  });
});

// End-to-end smoke: write a spec via the CRUD route, then run the SAME boot
// hydration the API's index.ts does (`loadAndRegisterDbSpecs`), and confirm the
// stored journey now shows up in the admin journeys list AND renders a
// full-fidelity graph — the whole "journey lives in data" path in one test.
describe("Slice 1 boot hydration (smoke)", () => {
  it("a stored spec is registered at boot and served by the journeys + graph routes", async () => {
    const id = `${RUN}-smoke`;
    const put = await app.request(`/v1/admin/journey-specs/${id}`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        specVersion: 1,
        id,
        meta: {
          name: "Smoke — data-defined journey",
          enabled: true,
          trigger: { event: `${RUN}.smoke` },
          entryLimit: "unlimited",
          suppress: { minutes: 1 },
        },
        steps: [
          {
            id: "hello",
            type: "send_email",
            template: "welcome",
            subject: "hi",
          },
          { id: "settle", type: "sleep", duration: { minutes: 5 } },
        ],
      }),
    });
    expect(put.status).toBe(200);

    // Simulate the API process boot step (index.ts calls this after createApp).
    await loadAndRegisterDbSpecs(container);

    // Now it behaves exactly like a code journey to every downstream reader.
    const list = await app.request("/v1/admin/journeys?limit=100", {
      headers: AUTH,
    });
    const listBody = await list.json();
    expect(listBody.journeys.some((j: { id: string }) => j.id === id)).toBe(
      true,
    );

    const graph = await app.request(`/v1/admin/journeys/${id}/graph`, {
      headers: AUTH,
    });
    expect(graph.status).toBe(200);
    const graphBody = await graph.json();
    expect(graphBody.graph.degraded).toBeUndefined(); // full fidelity
    const nodeIds = graphBody.graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain("start");
    expect(nodeIds).toContain("send:hello");
    expect(nodeIds).toContain("settle");
  });
});

describe("Slice 3 — version history, rollback, eject", () => {
  it("archives every write and lists versions newest-first", async () => {
    const id = `${RUN}-hist`;
    await put(id, specFor(id, "v1-name"));
    await put(id, specFor(id, "v2-name"));
    await put(id, specFor(id, "v3-name"));

    const res = await app.request(`/v1/admin/journey-specs/${id}/versions`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const versions = body.versions.map((v: { version: number }) => v.version);
    expect(versions).toEqual([3, 2, 1]); // newest first
  });

  it("rolls forward to a prior version's content at a new version number", async () => {
    const id = `${RUN}-rb`;
    // v1 = checkpoint "alpha"; v2 = checkpoint "beta".
    const v1 = {
      ...specFor(id),
      steps: [{ id: "alpha", type: "checkpoint" }],
    };
    const v2 = {
      ...specFor(id),
      steps: [{ id: "beta", type: "checkpoint" }],
    };
    await put(id, v1);
    await put(id, v2);

    // Roll back to version 1 → becomes the live spec at version 3.
    const rb = await app.request(`/v1/admin/journey-specs/${id}/rollback`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rb.status).toBe(200);
    expect((await rb.json()).spec.version).toBe(3);

    // The live document is v1's content (step id "alpha"), not v2's.
    const cur = await app.request(`/v1/admin/journey-specs/${id}`, {
      headers: AUTH,
    });
    const doc = await cur.json();
    expect(doc.spec.steps[0].id).toBe("alpha");
    expect(doc.summary.version).toBe(3);
  });

  it("404s rolling back to a missing version", async () => {
    const id = `${RUN}-rb404`;
    await put(id, specFor(id));
    const rb = await app.request(`/v1/admin/journey-specs/${id}/rollback`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ version: 99 }),
    });
    expect(rb.status).toBe(404);
  });

  it("ejects a spec to defineJourney() TypeScript source", async () => {
    const id = `${RUN}-eject`;
    await put(id, {
      ...specFor(id),
      steps: [
        { id: "hello", type: "send_email", template: "welcome", subject: "hi" },
        { id: "settle", type: "sleep", duration: { minutes: 5 } },
        {
          id: "gate",
          type: "branch",
          if: {
            type: "property",
            property: "plan",
            operator: "eq",
            value: "pro",
          },
          yes: [{ id: "done", type: "end" }],
          no: [{ id: "mark", type: "checkpoint" }],
        },
      ],
    });

    const res = await app.request(`/v1/admin/journey-specs/${id}/eject`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const { filename, code } = await res.json();
    expect(filename).toBe(`${id}.journey.ts`);
    // Faithful 1:1 translation to the runtime primitives.
    expect(code).toContain("defineJourney({");
    expect(code).toContain("await sendEmail({");
    expect(code).toContain("await ctx.sleep({");
    expect(code).toContain('user.properties["plan"] === "pro"');
    expect(code).toContain("await ctx.checkpoint(");
    expect(code).toContain("return;"); // the `end` step
  });
});
