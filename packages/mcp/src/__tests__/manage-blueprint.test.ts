/**
 * `manage_blueprint` — action dispatch, provenance stamping (source: "mcp"),
 * and HTTP-status → structured-result error mapping. Handlers never throw for
 * an expected failure; every outcome is a discriminated `ok` result.
 */
import { describe, expect, it } from "vitest";
import { createManageBlueprintTool } from "../tools/manage-blueprint.js";
import { httpError, makeClient } from "./helpers.js";

const validGraph = {
  journeyId: "welcome-flow",
  nodes: [
    { id: "start", type: "start", title: "Enroll" },
    { id: "end", type: "end-completed", title: "Done" },
  ],
  edges: [{ id: "e1", source: "start", target: "end" }],
};

function baseCreateInput() {
  return {
    action: "create" as const,
    name: "Welcome flow",
    triggerEvent: "signed_up",
    entryLimit: "once" as const,
    suppress: {},
    graph: validGraph,
  };
}

describe("manage_blueprint create", () => {
  it("posts to /v1/admin/blueprints and stamps source:mcp", async () => {
    const { client, calls } = makeClient({
      post: () => ({ blueprint: { id: "welcome-flow", status: "draft" } }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler(baseCreateInput())) as {
      ok: boolean;
      blueprint: { id: string };
    };

    expect(result.ok).toBe(true);
    expect(result.blueprint.id).toBe("welcome-flow");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/v1/admin/blueprints");
    // Provenance is stamped by the surface — never taken from tool input.
    expect((calls[0]?.body as { source: string }).source).toBe("mcp");
  });

  it("rejects a bad duration key LOCALLY (strict) — suppress:{days:7}", async () => {
    const { client, calls } = makeClient({ post: () => ({ blueprint: {} }) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      ...baseCreateInput(),
      suppress: { days: 7 },
    })) as { ok: boolean; code: string; issues: unknown[] };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    // The bad key is named locally — it never reaches the server to be stripped.
    expect(JSON.stringify(result.issues)).toContain("days");
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed property condition LOCALLY — triggerWhere:[{foo:'bar'}]", async () => {
    const { client, calls } = makeClient({ post: () => ({ blueprint: {} }) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      ...baseCreateInput(),
      triggerWhere: [{ foo: "bar" }],
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("accepts a well-formed property condition (type/property/operator)", async () => {
    const { client, calls } = makeClient({
      post: () => ({ blueprint: { id: "welcome-flow" } }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      ...baseCreateInput(),
      triggerWhere: [
        { type: "property", property: "score", operator: "lte", value: 6 },
      ],
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(
      (calls[0]?.body as { triggerWhere: unknown[] }).triggerWhere,
    ).toHaveLength(1);
  });

  it("strips null-valued optionals on create (the create route rejects null)", async () => {
    const { client, calls } = makeClient({
      post: () => ({ blueprint: { id: "welcome-flow" } }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      ...baseCreateInput(),
      description: null,
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    // null ≡ omitted on create — the field is dropped before POST.
    expect(calls[0]?.body).not.toHaveProperty("description");
  });

  it("returns invalid_input for a missing required field without calling the API", async () => {
    const { client, calls } = makeClient({
      post: () => ({ blueprint: {} }),
    });
    const tool = createManageBlueprintTool(client);

    const { triggerEvent: _omit, ...noTrigger } = baseCreateInput();
    const result = (await tool.handler(noTrigger)) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("maps a 422 to invalid_graph, passing the route's issues through verbatim", async () => {
    const issues = [
      {
        nodeId: "send",
        path: ["nodes", 1, "meta", "template"],
        code: "unknown_template",
        message: "not registered",
      },
    ];
    const { client } = makeClient({
      post: () => {
        throw httpError(422, {
          error: "Blueprint graph failed validation",
          issues,
        });
      },
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler(baseCreateInput())) as {
      ok: boolean;
      code: string;
      issues: unknown[];
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_graph");
    expect(result.issues).toEqual(issues);
  });

  it("maps a transport failure (status 0) to unreachable", async () => {
    const { client } = makeClient({
      post: () => {
        throw httpError(0, undefined);
      },
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler(baseCreateInput())) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unreachable");
  });
});

describe("manage_blueprint update", () => {
  it("patches by id with only the changed fields", async () => {
    const { client, calls } = makeClient({
      patch: () => ({ blueprint: { id: "welcome-flow", name: "Renamed" } }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "update",
      id: "welcome-flow",
      name: "Renamed",
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.path).toBe("/v1/admin/blueprints/welcome-flow");
    expect(calls[0]?.body).toEqual({ name: "Renamed" });
  });

  it("requires an id", async () => {
    const { client, calls } = makeClient({ patch: () => ({}) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "update", name: "x" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("rejects an update that sets no field besides id", async () => {
    const { client, calls } = makeClient({ patch: () => ({}) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "update", id: "x" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("rejects a status change on update — must use enable/disable", async () => {
    const { client, calls } = makeClient({ patch: () => ({ blueprint: {} }) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "update",
      id: "x",
      status: "enabled",
    })) as { ok: boolean; code: string; error: string };

    // NOT silently stripped — the agent must not think it went live.
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(result.error.toLowerCase()).toContain("status");
    expect(calls).toHaveLength(0);
  });

  it("falls back to conflict when a 409 body has no code", async () => {
    const { client } = makeClient({
      patch: () => {
        throw httpError(409, {
          error: 'Blueprint "x" was promoted to code — it is frozen',
        });
      },
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "update",
      id: "x",
      name: "y",
    })) as { ok: boolean; code: string; error: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("conflict");
    expect(result.error).toContain("promoted");
  });

  it("passes a 409's explicit code through (engine now sends in_flight/promoted)", async () => {
    const { client } = makeClient({
      patch: () => {
        throw httpError(409, {
          error: "enrollments active",
          code: "in_flight",
        });
      },
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "update",
      id: "x",
      graph: validGraph,
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("in_flight");
  });
});

describe("manage_blueprint validate", () => {
  it("validates an unsaved graph (200, valid:false is success)", async () => {
    const issues = [{ path: [], code: "bad", message: "nope" }];
    const { client, calls } = makeClient({
      post: () => ({ valid: false, issues }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "validate",
      graph: validGraph,
    })) as { ok: boolean; valid: boolean; issues: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(issues);
    expect(calls[0]?.path).toBe("/v1/admin/blueprints/validate");
  });

  it("re-validates a stored blueprint by id", async () => {
    const { client, calls } = makeClient({
      post: () => ({ valid: true, issues: [] }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "validate", id: "x" })) as {
      ok: boolean;
      valid: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(calls[0]?.path).toBe("/v1/admin/blueprints/x/validate");
  });

  it("rejects when neither graph nor id is provided", async () => {
    const { client, calls } = makeClient({ post: () => ({}) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "validate" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("rejects when BOTH graph and id are provided", async () => {
    const { client } = makeClient({ post: () => ({}) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({
      action: "validate",
      id: "x",
      graph: validGraph,
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
  });
});

describe("manage_blueprint enable/disable", () => {
  it("enables by id", async () => {
    const { client, calls } = makeClient({
      post: () => ({ blueprint: { id: "x", status: "enabled" } }),
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "enable", id: "x" })) as {
      ok: boolean;
    };

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe("/v1/admin/blueprints/x/enable");
  });

  it("maps a 404 on disable to not_found", async () => {
    const { client } = makeClient({
      post: () => {
        throw httpError(404, { error: 'Blueprint "ghost" not found' });
      },
    });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "disable", id: "ghost" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found");
  });

  it("requires an id to enable", async () => {
    const { client, calls } = makeClient({ post: () => ({}) });
    const tool = createManageBlueprintTool(client);

    const result = (await tool.handler({ action: "enable" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});
