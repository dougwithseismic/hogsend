import { afterEach, describe, expect, it, vi } from "vitest";

// Pure fetch mocking — the provisioner is HTTP-only (no DB, no Hatchet).
//
// The lib is not exported from @hogsend/engine yet (the cli-connect lane
// imports it via relative path), so it's loaded at runtime through Vite. A
// LITERAL static import into another package's src would pull those files
// into THIS package's TS program and trip rootDir (TS6059) under
// `tsc --noEmit`; the variable specifier keeps tsc out of it. The shapes
// below mirror the lib's exported types.

type ProvisionPostHogLoopResult = {
  action: "created" | "updated" | "unchanged";
  functionId: string;
  projectId: string;
  webhookUrl: string;
  dashboardUrl: string;
};

type ProvisionPostHogLoopErrorShape = Error & {
  code:
    | "missing-webhook-secret"
    | "unauthorized"
    | "missing-scope"
    | "unsupported-instance"
    | "project-discovery-failed"
    | "api-error";
  remediation: string;
  status?: number;
};

type LoggerLike = {
  info: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
  debug: (...args: unknown[]) => unknown;
};

type ProvisionPostHogLoopOptions = {
  privateHost: string;
  accessToken: string;
  projectId?: string | number;
  apiPublicUrl: string;
  webhookSecret: string | undefined;
  logger: LoggerLike;
  name?: string;
};

const providerModulePath = new URL(
  "../../../../packages/engine/src/lib/provision-posthog-loop.ts",
  import.meta.url,
).pathname;
const { provisionPostHogLoop, ProvisionPostHogLoopError } = (await import(
  /* @vite-ignore */ providerModulePath
)) as {
  provisionPostHogLoop: (
    opts: ProvisionPostHogLoopOptions,
  ) => Promise<ProvisionPostHogLoopResult>;
  ProvisionPostHogLoopError: new (opts: {
    code: ProvisionPostHogLoopErrorShape["code"];
    message: string;
    remediation: string;
    status?: number;
  }) => ProvisionPostHogLoopErrorShape;
};

const HOST = "https://eu.posthog.com";
const CURRENT_URL = `${HOST}/api/projects/@current/`;
const BASE = `${HOST}/api/environments/4242/hog_functions/`;
const LIST_URL = `${BASE}?type=destination&limit=100`;
const WEBHOOK_URL = "https://t.example.com/v1/webhooks/posthog";

const IS_IDENTIFIED = {
  key: "$is_identified",
  type: "event",
  value: ["true"],
  operator: "exact",
};

type RecordedCall = {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
};

type SentBody = {
  enabled?: boolean;
  type?: string;
  name?: string;
  description?: string;
  template_id?: string;
  hog?: string;
  inputs_schema?: Array<{ key: string }>;
  inputs: Record<string, { value: unknown }>;
  filters: { source?: string; properties?: unknown[]; bytecode?: unknown };
};

type FixtureDetail = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  template: { id: string } | null;
  masking: null;
  mappings: null;
  inputs: Record<string, { value: unknown }>;
  filters: { source?: string; properties?: unknown[]; bytecode?: unknown };
  inputs_schema: Array<{ key: string; type?: string }>;
};

/** Dogfood-shaped detail fixture (the hand-made function being adopted). */
function adoptedDetail(): FixtureDetail {
  return structuredClone({
    id: "fn_1",
    name: "Hogsend ingest — identified events",
    type: "destination",
    enabled: true,
    template: { id: "template-webhook" },
    masking: null,
    mappings: null,
    inputs: {
      url: { value: WEBHOOK_URL as unknown },
      method: { value: "POST" as unknown },
      body: { value: { event: "{event}", person: "{person}" } as unknown },
      headers: {
        value: {
          "Content-Type": "application/json",
          "x-posthog-webhook-secret": "s3cret",
        } as unknown,
      },
      debug: { value: false as unknown },
    },
    filters: {
      source: "events",
      properties: [{ ...IS_IDENTIFIED }] as unknown[],
      bytecode: ["_H", 1] as unknown,
    },
    inputs_schema: [
      { key: "url", type: "string" },
      { key: "method", type: "choice" },
      { key: "body", type: "json" },
      { key: "headers", type: "dictionary" },
      { key: "debug", type: "boolean" },
    ],
  });
}

function listItem(id: string, name: string) {
  return { id, name, type: "destination", enabled: true };
}

function listPage(results: unknown[], next: string | null = null) {
  return { count: results.length, next, previous: null, results };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function stubRoutes(routes: Record<string, () => Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        url,
        auth: headers.Authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const handler = routes[`${method} ${url}`];
      if (!handler) throw new Error(`Unexpected fetch: ${method} ${url}`);
      return handler();
    }),
  );
  return calls;
}

function stubLogger() {
  const raw = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { raw, logger: raw as LoggerLike };
}

function baseOpts(logger: LoggerLike) {
  return {
    privateHost: HOST,
    accessToken: "phx_test",
    apiPublicUrl: "https://t.example.com",
    webhookSecret: "s3cret" as string | undefined,
    logger,
  };
}

function bodyOf(call: RecordedCall | undefined): SentBody {
  if (!call) throw new Error("expected a recorded call");
  return call.body as SentBody;
}

function callList(calls: RecordedCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.url}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisionPostHogLoop", () => {
  it("refuses without a webhook secret, before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { logger } = stubLogger();

    for (const webhookSecret of [undefined, ""]) {
      const err = await provisionPostHogLoop({
        ...baseOpts(logger),
        webhookSecret,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisionPostHogLoopError);
      const typed = err as ProvisionPostHogLoopErrorShape;
      expect(typed.code).toBe("missing-webhook-secret");
      expect(typed.remediation).toContain("POSTHOG_WEBHOOK_SECRET");
      expect(typed.remediation).toContain(
        "hogsend connect posthog --provision-only",
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates the destination when nothing is adoptable", async () => {
    const { logger } = stubLogger();
    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () => json(listPage([])),
      [`POST ${BASE}`]: () => json({ ...adoptedDetail(), id: "fn_new" }, 201),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(callList(calls)).toEqual([
      `GET ${CURRENT_URL}`,
      `GET ${LIST_URL}`,
      `POST ${BASE}`,
    ]);
    expect(calls.every((c) => c.auth === "Bearer phx_test")).toBe(true);

    const body = bodyOf(calls[2]);
    expect(body.type).toBe("destination");
    expect(body.template_id).toBe("template-webhook");
    expect(body.enabled).toBe(true);
    expect(body.name).toBe("Hogsend ingest — identified events");
    expect(Object.keys(body.inputs).sort()).toEqual([
      "body",
      "debug",
      "headers",
      "method",
      "url",
    ]);
    expect(body.inputs.url?.value).toBe(WEBHOOK_URL);
    expect(body.inputs.method?.value).toBe("POST");
    expect(body.inputs.body?.value).toEqual({
      event: "{event}",
      person: "{person}",
    });
    expect(body.inputs.headers?.value).toEqual({
      "Content-Type": "application/json",
      "x-posthog-webhook-secret": "s3cret",
    });
    expect(body.inputs.debug?.value).toBe(false);
    expect(body.filters).toEqual({
      source: "events",
      properties: [IS_IDENTIFIED],
    });
    expect(JSON.stringify(body)).not.toContain("bytecode");

    expect(result).toMatchObject({
      action: "created",
      functionId: "fn_new",
      projectId: "4242",
      webhookUrl: WEBHOOK_URL,
    });
    expect(result.dashboardUrl).toBe(
      `${HOST}/project/4242/pipeline/destinations/hog-fn_new/configuration`,
    );
  });

  it("short-circuits @current discovery when projectId is given", async () => {
    const { logger } = stubLogger();
    const base77 = `${HOST}/api/environments/77/hog_functions/`;
    const calls = stubRoutes({
      [`GET ${base77}?type=destination&limit=100`]: () => json(listPage([])),
      [`POST ${base77}`]: () => json({ id: "fn_new" }, 201),
    });

    const result = await provisionPostHogLoop({
      ...baseOpts(logger),
      projectId: 77,
    });

    expect(callList(calls)).toEqual([
      `GET ${base77}?type=destination&limit=100`,
      `POST ${base77}`,
    ]);
    expect(result.projectId).toBe("77");
  });

  it("adopts a compliant function without writing (unchanged)", async () => {
    const { logger } = stubLogger();
    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
        ),
      [`GET ${BASE}fn_1/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(callList(calls)).toEqual([
      `GET ${CURRENT_URL}`,
      `GET ${LIST_URL}`,
      `GET ${BASE}fn_1/`,
    ]);
    expect(result).toMatchObject({ action: "unchanged", functionId: "fn_1" });
  });

  it("reconciles drift while preserving operator extras", async () => {
    const { logger } = stubLogger();
    const detail = adoptedDetail();
    detail.inputs.url = {
      value: "https://old-host.example/v1/webhooks/posthog",
    };
    detail.inputs.headers = { value: { "x-custom": "keep" } };
    const currentUrlEntry = {
      key: "$current_url",
      type: "event",
      value: "https://app.example.com",
      operator: "icontains",
    };
    detail.filters.properties = [currentUrlEntry];

    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
        ),
      [`GET ${BASE}fn_1/`]: () => json(detail),
      [`PATCH ${BASE}fn_1/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(callList(calls)).toEqual([
      `GET ${CURRENT_URL}`,
      `GET ${LIST_URL}`,
      `GET ${BASE}fn_1/`,
      `PATCH ${BASE}fn_1/`,
    ]);

    const body = bodyOf(calls[3]);
    expect(body.enabled).toBe(true);
    expect(Object.keys(body.inputs).sort()).toEqual([
      "body",
      "debug",
      "headers",
      "method",
      "url",
    ]);
    expect(body.inputs.url?.value).toBe(WEBHOOK_URL);
    expect(body.inputs.headers?.value).toEqual({
      "x-custom": "keep",
      "Content-Type": "application/json",
      "x-posthog-webhook-secret": "s3cret",
    });
    expect(body.filters.properties).toEqual([currentUrlEntry, IS_IDENTIFIED]);
    expect("bytecode" in body.filters).toBe(false);
    expect(result.action).toBe("updated");
  });

  it("rotates a stale webhook secret", async () => {
    const { logger } = stubLogger();
    const detail = adoptedDetail();
    detail.inputs.headers = {
      value: {
        "Content-Type": "application/json",
        "x-posthog-webhook-secret": "old",
      },
    };
    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
        ),
      [`GET ${BASE}fn_1/`]: () => json(detail),
      [`PATCH ${BASE}fn_1/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(result.action).toBe("updated");
    const body = bodyOf(calls[3]);
    expect(body.inputs.headers?.value).toEqual({
      "Content-Type": "application/json",
      "x-posthog-webhook-secret": "s3cret",
    });
  });

  it("re-enables a disabled loop", async () => {
    const { logger } = stubLogger();
    const detail = adoptedDetail();
    detail.enabled = false;
    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
        ),
      [`GET ${BASE}fn_1/`]: () => json(detail),
      [`PATCH ${BASE}fn_1/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(result.action).toBe("updated");
    expect(bodyOf(calls[3]).enabled).toBe(true);
  });

  it('tolerates filter value representations ([true] and "true")', async () => {
    const { logger } = stubLogger();

    for (const value of [[true], "true"]) {
      const detail = adoptedDetail();
      detail.filters.properties = [{ ...IS_IDENTIFIED, value }];
      const calls = stubRoutes({
        [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
        [`GET ${LIST_URL}`]: () =>
          json(
            listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
          ),
        [`GET ${BASE}fn_1/`]: () => json(detail),
      });

      const result = await provisionPostHogLoop(baseOpts(logger));
      expect(result.action).toBe("unchanged");
      expect(calls).toHaveLength(3);
    }
  });

  it("paginates and probes hogsend-named candidates first", async () => {
    const { logger } = stubLogger();
    const page2Path = `${BASE}?type=destination&limit=100&offset=100`;
    const matching = adoptedDetail();
    matching.id = "fn_loop";
    matching.name = "My hogsend loop";

    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(listPage([listItem("fn_slack", "Slack alerts")], page2Path)),
      [`GET ${page2Path}`]: () =>
        json(listPage([listItem("fn_loop", "My hogsend loop")])),
      [`GET ${BASE}fn_loop/`]: () => json(matching),
      // fn_slack's detail must never be requested — the hogsend-named
      // candidate is probed first and matches.
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(callList(calls)).toEqual([
      `GET ${CURRENT_URL}`,
      `GET ${LIST_URL}`,
      `GET ${page2Path}`,
      `GET ${BASE}fn_loop/`,
    ]);
    expect(result).toMatchObject({
      action: "unchanged",
      functionId: "fn_loop",
    });
  });

  it("normalizes legacy Go-CLI functions (hog + inputs_schema)", async () => {
    const { logger } = stubLogger();
    const legacy = adoptedDetail();
    legacy.id = "fn_go";
    legacy.name = "Hogsend";
    legacy.template = null;
    legacy.inputs = {
      url: { value: WEBHOOK_URL },
      method: { value: "POST" },
      headers: {
        value: {
          "Content-Type": "application/json",
          "x-posthog-webhook-secret": "s3cret",
        },
      },
      payload: { value: { event: "{event}", person: "{person}" } },
    };
    legacy.inputs_schema = [
      { key: "url" },
      { key: "method" },
      { key: "headers" },
      { key: "payload" },
    ];
    legacy.filters = { source: "events", properties: [{ ...IS_IDENTIFIED }] };

    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () => json(listPage([listItem("fn_go", "Hogsend")])),
      [`GET ${BASE}fn_go/`]: () => json(legacy),
      [`PATCH ${BASE}fn_go/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));

    expect(result.action).toBe("updated");
    const body = bodyOf(calls[3]);
    expect(typeof body.hog).toBe("string");
    expect(body.hog).toContain("fetch(inputs.url, payload)");
    expect(body.inputs_schema?.map((f) => f.key)).toEqual([
      "url",
      "method",
      "body",
      "headers",
      "debug",
    ]);
    expect(Object.keys(body.inputs).sort()).toEqual([
      "body",
      "debug",
      "headers",
      "method",
      "url",
    ]);
    expect(body.inputs.body?.value).toEqual({
      event: "{event}",
      person: "{person}",
    });
  });

  it("maps 403 to missing-scope with the PostHog detail", async () => {
    const { logger } = stubLogger();
    stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          {
            type: "authentication_error",
            code: "permission_denied",
            detail: "API key missing required scope.",
          },
          403,
        ),
    });

    const err = await provisionPostHogLoop(baseOpts(logger)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProvisionPostHogLoopError);
    const typed = err as ProvisionPostHogLoopErrorShape;
    expect(typed.code).toBe("missing-scope");
    expect(typed.status).toBe(403);
    expect(typed.message).toContain("API key missing required scope.");
    expect(typed.remediation).toContain("hog_function:write");
  });

  it("maps 404 on the collection to unsupported-instance", async () => {
    const { logger } = stubLogger();
    stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json({ type: "invalid_request", detail: "Not found." }, 404),
    });

    const err = await provisionPostHogLoop(baseOpts(logger)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProvisionPostHogLoopError);
    const typed = err as ProvisionPostHogLoopErrorShape;
    expect(typed.code).toBe("unsupported-instance");
    expect(typed.status).toBe(404);
    expect(typed.remediation).toContain("manually");
  });

  it("maps @current failure to project-discovery-failed", async () => {
    const { logger } = stubLogger();
    const calls = stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ error: "boom" }, 500),
    });

    const err = await provisionPostHogLoop(baseOpts(logger)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProvisionPostHogLoopError);
    const typed = err as ProvisionPostHogLoopErrorShape;
    expect(typed.code).toBe("project-discovery-failed");
    expect(typed.remediation).toContain("POSTHOG_PROJECT_ID");
    expect(calls).toHaveLength(1);
  });

  it("never logs the webhook secret or access token", async () => {
    const { raw, logger } = stubLogger();
    const detail = adoptedDetail();
    detail.inputs.headers = {
      value: {
        "Content-Type": "application/json",
        "x-posthog-webhook-secret": "old",
      },
    };
    stubRoutes({
      [`GET ${CURRENT_URL}`]: () => json({ id: 4242 }),
      [`GET ${LIST_URL}`]: () =>
        json(
          listPage([listItem("fn_1", "Hogsend ingest — identified events")]),
        ),
      [`GET ${BASE}fn_1/`]: () => json(detail),
      [`PATCH ${BASE}fn_1/`]: () => json(adoptedDetail()),
    });

    const result = await provisionPostHogLoop(baseOpts(logger));
    expect(result.action).toBe("updated");

    const logged = [raw.info, raw.warn, raw.error, raw.debug]
      .flatMap((fn) => fn.mock.calls)
      .map((args) => JSON.stringify(args))
      .join(" ");
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("phx_test");
  });
});
