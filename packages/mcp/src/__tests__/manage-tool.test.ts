/**
 * manage_journey safety contract against a recording stub client:
 * disabled-at-birth create, verbatim server errors, confirm-gated enable,
 * rollback listing, and the 409 id-collision path.
 */
import { describe, expect, it } from "vitest";
import type { AdminClient, HttpError, Query } from "../client.js";
import { manageTool } from "../tools/manage.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: Query;
}

function recordingClient(routes: Record<string, unknown | (() => never)>): {
  client: AdminClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const lookup = (path: string): unknown => {
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    if (hit !== undefined) {
      const value = routes[hit];
      if (typeof value === "function") (value as () => never)();
      return value;
    }
    const err = new Error(`404: no stub for ${path}`) as HttpError;
    err.name = "HttpError";
    err.status = 404;
    err.body = { error: "Not found" };
    throw err;
  };
  return {
    calls,
    client: {
      baseUrl: "http://test.local",
      get: async <T>(path: string, query?: Query) => {
        calls.push({ method: "GET", path, query });
        return lookup(path) as T;
      },
      post: async <T>(path: string, body: unknown) => {
        calls.push({ method: "POST", path, body });
        return lookup(path) as T;
      },
      put: async <T>(path: string, body: unknown, query?: Query) => {
        calls.push({ method: "PUT", path, body, query });
        return lookup(path) as T;
      },
      patch: async <T>(path: string, body: unknown) => {
        calls.push({ method: "PATCH", path, body });
        return lookup(path) as T;
      },
    },
  };
}

function httpThrow(status: number, error: string): () => never {
  return () => {
    const err = new Error(`${status}: ${error}`) as HttpError;
    err.name = "HttpError";
    err.status = status;
    err.body = { error };
    throw err;
  };
}

const VALID_SPEC = {
  specVersion: 1,
  id: "nudge",
  meta: {
    name: "Nudge",
    enabled: true,
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
    suppress: { minutes: 1 },
  },
  steps: [{ id: "note", type: "checkpoint" }],
};

describe("manage_journey", () => {
  it("create is born disabled (PUT carries enabled=false) and returns a walkthrough", async () => {
    const { client, calls } = recordingClient({
      "/v1/admin/journey-specs/nudge": {
        spec: { id: "nudge", name: "Nudge", enabled: false, version: 1 },
        created: true,
      },
      "/v1/admin/journeys/nudge/graph": { graph: { nodes: [] } },
    });
    const res = await manageTool.handler(
      { action: "create", id: "nudge", spec: VALID_SPEC },
      client,
    );
    expect(res.isError).toBeUndefined();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.query).toEqual({ enabled: "false" }); // disabled at birth
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("NOT live");
    expect(text).toContain("Starts when"); // walkthrough present
  });

  it("update does NOT touch the enabled state", async () => {
    const { client, calls } = recordingClient({
      "/v1/admin/journey-specs/nudge": {
        spec: { id: "nudge", name: "Nudge", enabled: true, version: 2 },
        created: false,
      },
      "/v1/admin/journeys/nudge/graph": { graph: { nodes: [] } },
    });
    await manageTool.handler(
      { action: "update", id: "nudge", spec: VALID_SPEC },
      client,
    );
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.query).toBeUndefined();
  });

  it("rejects an invalid spec locally with actionable issues", async () => {
    const { client, calls } = recordingClient({});
    const res = await manageTool.handler(
      { action: "create", id: "bad", spec: { specVersion: 1, id: "bad" } },
      client,
    );
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as { text: string }).text).toContain("meta");
    expect(calls).toHaveLength(0); // never reached the server
  });

  it("surfaces the server 409 code-wins error with an id suggestion", async () => {
    const { client } = recordingClient({
      "/v1/admin/journey-specs/nudge": httpThrow(
        409,
        'Journey id "nudge" is defined by a code journey; code journeys win',
      ),
    });
    const res = await manageTool.handler(
      { action: "create", id: "nudge", spec: VALID_SPEC },
      client,
    );
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("code journey");
    expect(text).toContain("nudge-v2"); // suggested alternative
  });

  it("refuses enable without a confirm echo", async () => {
    const { client, calls } = recordingClient({});
    const res = await manageTool.handler(
      { action: "enable", id: "nudge" },
      client,
    );
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as { text: string }).text).toContain("confirm");
    expect(calls).toHaveLength(0); // no write happened
  });

  it("enable with confirm PATCHes the spec route", async () => {
    const { client, calls } = recordingClient({
      "/v1/admin/journey-specs/nudge": {
        spec: { id: "nudge", enabled: true, version: 1 },
      },
    });
    const res = await manageTool.handler(
      { action: "enable", id: "nudge", confirm: "yes, turn it on" },
      client,
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/v1/admin/journey-specs/nudge",
      body: { enabled: true },
    });
  });

  it("enable falls back to the code-journey PATCH on 404", async () => {
    const { client, calls } = recordingClient({
      "/v1/admin/journeys/nudge": { journey: { id: "nudge", enabled: true } },
    });
    const res = await manageTool.handler(
      { action: "enable", id: "nudge", confirm: "go live" },
      client,
    );
    expect(res.isError).toBeUndefined();
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/admin/journey-specs/nudge", // 404s
      "/v1/admin/journeys/nudge", // fallback
    ]);
  });

  it("rollback without version lists versions and writes nothing", async () => {
    const { client, calls } = recordingClient({
      "/v1/admin/journey-specs/nudge/versions": {
        versions: [
          { version: 2, createdAt: "2026-07-10" },
          { version: 1, createdAt: "2026-07-09" },
        ],
      },
    });
    const res = await manageTool.handler(
      { action: "rollback", id: "nudge" },
      client,
    );
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("v2");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
