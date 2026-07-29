import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSubstrateContract } from "../substrate/contract";
import { RAILWAY_SUBSTRATE_ID, RailwaySubstrate } from "../substrate/railway";
import {
  isRetryableHttp,
  RAILWAY_API_URL,
  RailwayClient,
  type RailwayTransport,
  railwayBackoffMs,
} from "../substrate/railway/client";
import type { StackRefs, StackSpec } from "../substrate/types";
import { SubstrateError } from "../substrate/types";

/**
 * `RailwaySubstrate` against an in-memory Railway.
 *
 * NO test in this file touches the network: every request goes through an
 * injected transport. The emulator is deliberately STRICT — an operation it
 * does not recognise throws, so a typo'd document or a mutation nobody
 * emulated fails the suite instead of silently returning `{}` and letting a
 * contract assertion pass on a lie.
 */

// ---------------------------------------------------------------------------
// The emulator
// ---------------------------------------------------------------------------

interface MockService {
  id: string;
  name: string;
  image: string;
  region?: string;
  numReplicas: number;
  preDeployCommand?: string;
  startCommand?: string;
  variables: Record<string, string>;
  deploymentStatus: string;
  deployCount: number;
  serviceDomain?: string;
  customDomains: string[];
}

interface MockProject {
  id: string;
  name: string;
  workspaceId?: string;
  environments: { id: string; name: string }[];
  services: Map<string, MockService>;
}

class UnknownOperationError extends Error {}

/**
 * A minimal, honest Railway. It models exactly the fields the substrate reads
 * back, and nothing else — the point is to prove the substrate's REQUESTS are
 * right, so every recognised operation mutates real state that a later query
 * observes.
 */
class RailwayMock {
  readonly projects = new Map<string, MockProject>();
  /** Every operation name seen, in order — lets a test assert call shape. */
  readonly operations: string[] = [];
  /** Scripted HTTP responses, consumed before any real handling. */
  private readonly scripted: { status: number; body: string }[] = [];
  private seq = 0;

  /** Queue one raw HTTP response (a 429/400/5xx) ahead of normal handling. */
  scriptResponse(status: number, body = "{}"): this {
    this.scripted.push({ status, body });
    return this;
  }

  readonly transport: RailwayTransport = async ({ body }) => {
    const scripted = this.scripted.shift();
    if (scripted) return scripted;

    const request = JSON.parse(body) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const match = /^\s*(?:query|mutation)\s+(\w+)/.exec(request.query);
    if (!match) throw new UnknownOperationError(request.query.slice(0, 80));
    const operation = match[1];
    if (!operation) throw new UnknownOperationError(request.query);
    this.operations.push(operation);

    const data = this.handle(operation, request.variables ?? {});
    return { status: 200, body: JSON.stringify({ data }) };
  };

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private project(id: unknown): MockProject {
    const project = this.projects.get(String(id));
    if (!project) throw new Error(`mock: no project ${String(id)}`);
    return project;
  }

  private service(serviceId: unknown): MockService {
    for (const project of this.projects.values()) {
      const found = project.services.get(String(serviceId));
      if (found) return found;
    }
    throw new Error(`mock: no service ${String(serviceId)}`);
  }

  private handle(
    operation: string,
    vars: Record<string, unknown>,
  ): Record<string, unknown> {
    const input = (vars.input ?? {}) as Record<string, unknown>;

    switch (operation) {
      case "Projects":
        return {
          projects: {
            edges: [...this.projects.values()].map((project) => ({
              node: { id: project.id, name: project.name },
            })),
          },
        };

      case "ProjectCreate": {
        const project: MockProject = {
          id: this.id("prj"),
          name: String(input.name),
          workspaceId: input.workspaceId as string | undefined,
          environments: [{ id: this.id("env"), name: "production" }],
          services: new Map(),
        };
        this.projects.set(project.id, project);
        return { projectCreate: { id: project.id, name: project.name } };
      }

      case "ProjectEnvironments": {
        const project = this.project(vars.projectId);
        return {
          environments: {
            edges: project.environments.map((node) => ({ node })),
          },
        };
      }

      case "ProjectServices": {
        const project = this.project(vars.projectId);
        return {
          project: {
            services: {
              edges: [...project.services.values()].map((service) => ({
                node: { id: service.id, name: service.name },
              })),
            },
          },
        };
      }

      case "ServiceCreate": {
        const project = this.project(input.projectId);
        const source = (input.source ?? {}) as Record<string, unknown>;
        const service: MockService = {
          id: this.id("svc"),
          name: String(input.name),
          image: String(source.image ?? ""),
          numReplicas: 1,
          variables: {},
          deploymentStatus: "SUCCESS",
          deployCount: 1,
          customDomains: [],
        };
        project.services.set(service.id, service);
        return { serviceCreate: { id: service.id, name: service.name } };
      }

      case "ServiceInstanceUpdate": {
        // Live schema shape: serviceId rides top-level, never inside input.
        if (typeof vars.serviceId !== "string" || "serviceId" in input) {
          throw new Error(
            "ServiceInstanceUpdate: serviceId must be a top-level variable",
          );
        }
        const service = this.service(vars.serviceId);
        const source = input.source as Record<string, unknown> | undefined;
        if (source?.image) service.image = String(source.image);
        if (typeof input.region === "string") service.region = input.region;
        if (typeof input.numReplicas === "number") {
          service.numReplicas = input.numReplicas;
        }
        if (typeof input.preDeployCommand === "string") {
          service.preDeployCommand = input.preDeployCommand;
        }
        if (typeof input.startCommand === "string") {
          service.startCommand = input.startCommand;
        }
        return { serviceInstanceUpdate: true };
      }

      case "ServiceInstanceRedeploy": {
        const service = this.service(vars.serviceId);
        service.deployCount += 1;
        service.deploymentStatus = "SUCCESS";
        return { serviceInstanceRedeploy: true };
      }

      case "ServiceInstanceStatus": {
        const service = this.service(vars.serviceId);
        return {
          serviceInstance: {
            numReplicas: service.numReplicas,
            latestDeployment: { status: service.deploymentStatus },
          },
        };
      }

      case "VariableCollectionUpsert": {
        const service = this.service(input.serviceId);
        Object.assign(
          service.variables,
          input.variables as Record<string, string>,
        );
        return { variableCollectionUpsert: true };
      }

      case "VariableDelete": {
        const service = this.service(input.serviceId);
        delete service.variables[String(input.name)];
        return { variableDelete: true };
      }

      case "ServiceDomains": {
        const service = this.service(vars.serviceId);
        return {
          domains: {
            serviceDomains: service.serviceDomain
              ? [{ domain: service.serviceDomain }]
              : [],
          },
        };
      }

      case "ServiceDomainCreate": {
        const service = this.service(input.serviceId);
        service.serviceDomain ??= `${service.name}-${service.id}.up.railway.app`;
        return { serviceDomainCreate: { domain: service.serviceDomain } };
      }

      case "CustomDomainCreate": {
        const service = this.service(input.serviceId);
        const domain = String(input.domain);
        service.customDomains.push(domain);
        return {
          customDomainCreate: {
            id: this.id("dom"),
            domain,
            status: {
              dnsRecords: [
                {
                  recordType: "CNAME",
                  hostlabel: domain,
                  requiredValue: `${service.id}.up.railway.app`,
                  zone: "acme.test",
                },
                {
                  recordType: "TXT",
                  hostlabel: `_railway.${domain}`,
                  requiredValue: "railway-verify=abc123",
                  zone: "acme.test",
                },
              ],
            },
          },
        };
      }

      case "ServiceDelete": {
        for (const project of this.projects.values()) {
          if (project.services.delete(String(vars.id))) {
            return { serviceDelete: true };
          }
        }
        throw new Error(`mock: no service ${String(vars.id)}`);
      }

      default:
        throw new UnknownOperationError(operation);
    }
  }

  /** Test-only read of emulated state, by service name. */
  find(name: string): MockService | undefined {
    for (const project of this.projects.values()) {
      for (const service of project.services.values()) {
        if (service.name === name) return service;
      }
    }
    return undefined;
  }
}

/** No sleeping in tests; record the delays instead. */
function recordingSleep(into: number[]) {
  return async (ms: number) => {
    into.push(ms);
  };
}

function makeSubstrate(mock = new RailwayMock(), sleeps: number[] = []) {
  return new RailwaySubstrate({
    token: "test-token",
    transport: mock.transport,
    sleep: recordingSleep(sleeps),
  });
}

const SPEC: StackSpec = {
  stackId: "55555555-5555-4555-8555-555555555555",
  organizationId: "66666666-6666-4666-8666-666666666666",
  environmentName: "staging",
  region: "eu",
  topology: "shared",
  initialImage: "hogsend-default:0.56.0",
  preDeployCommand: "tsx scripts/migrate.ts",
  workerStartCommand: "node dist/worker.js",
  env: { LOG_LEVEL: "info" },
};

// ---------------------------------------------------------------------------
// The contract — the same assertions FakeSubstrate passes
// ---------------------------------------------------------------------------

describeSubstrateContract("RailwaySubstrate (mocked transport)", () => {
  const mock = new RailwayMock();
  const provider = makeSubstrate(mock);
  return {
    provider,
    /**
     * Reads the emulated Railway's own state. Every write under test still
     * went through a real mutation document — this only avoids re-implementing
     * the read documents in the test.
     */
    inspect: async (refs: StackRefs) => {
      const env = refs.data.environmentName as string;
      const read = (suffix: string) => {
        const service = mock.find(`${env}-${suffix}`);
        if (!service) throw new Error(`mock: missing ${env}-${suffix}`);
        return service;
      };
      const api = read("api");
      const worker = read("worker");
      const strip = (service: MockService) => {
        // PORT is the substrate's own doing (the api service must listen where
        // the engine's Dockerfile does); it is not part of the caller's env.
        const { PORT: _port, ...rest } = service.variables;
        return rest;
      };
      return {
        services: {
          api: { image: api.image, running: api.numReplicas > 0 },
          worker: { image: worker.image, running: worker.numReplicas > 0 },
        },
        env: { api: strip(api), worker: strip(worker) },
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Railway specifics
// ---------------------------------------------------------------------------

describe("RailwayClient retry classifier", () => {
  it("retries throttling and server faults, not client mistakes", () => {
    expect(isRetryableHttp(429, "")).toBe(true);
    expect(isRetryableHttp(500, "")).toBe(true);
    expect(isRetryableHttp(502, "")).toBe(true);
    expect(isRetryableHttp(401, "unauthorized")).toBe(false);
    expect(isRetryableHttp(404, "not found")).toBe(false);
  });

  it("retries the known-flaky 400 shapes only", () => {
    // Railway's documented intermittent failure: a 400 with no usable error.
    expect(isRetryableHttp(400, "Problem processing request")).toBe(true);
    expect(isRetryableHttp(400, "not json at all")).toBe(true);
    expect(isRetryableHttp(400, JSON.stringify({ errors: [] }))).toBe(true);
    // A real validation error is permanent: retrying burns the budget.
    expect(
      isRetryableHttp(
        400,
        JSON.stringify({
          errors: [{ message: "Field 'nope' is not defined" }],
        }),
      ),
    ).toBe(false);
  });

  it("backs off exponentially with deterministic, jitterless delays", () => {
    expect([1, 2, 3, 4].map(railwayBackoffMs)).toEqual([250, 500, 1000, 2000]);
  });
});

describe("RailwayClient transport behaviour", () => {
  it("retries a 429 up to the cap, sleeping the backoff sequence", async () => {
    const mock = new RailwayMock();
    const sleeps: number[] = [];
    mock.scriptResponse(429).scriptResponse(429);
    const client = new RailwayClient({
      token: "t",
      transport: mock.transport,
      sleep: recordingSleep(sleeps),
    });

    await client.request(
      "query Projects { projects { edges { node { id } } } }",
    );

    expect(sleeps).toEqual([250, 500]);
  });

  it("retries a flaky 400 and then succeeds", async () => {
    const mock = new RailwayMock();
    const sleeps: number[] = [];
    mock.scriptResponse(400, "Problem processing request");
    const client = new RailwayClient({
      token: "t",
      transport: mock.transport,
      sleep: recordingSleep(sleeps),
    });

    const data = await client.request<{ projects: unknown }>(
      "query Projects { projects { edges { node { id } } } }",
    );

    expect(data.projects).toBeTruthy();
    expect(sleeps).toEqual([250]);
  });

  it("gives up after 5 attempts with a RETRYABLE error", async () => {
    const mock = new RailwayMock();
    const sleeps: number[] = [];
    for (let i = 0; i < 6; i += 1) mock.scriptResponse(503);
    const client = new RailwayClient({
      token: "t",
      transport: mock.transport,
      sleep: recordingSleep(sleeps),
    });

    const error = await client
      .request("query Projects { projects { edges { node { id } } } }")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SubstrateError);
    expect((error as SubstrateError).retryable).toBe(true);
    expect(sleeps).toHaveLength(4);
  });

  it("surfaces a GraphQL error as a PERMANENT failure", async () => {
    const client = new RailwayClient({
      token: "t",
      transport: async () => ({
        status: 200,
        body: JSON.stringify({ errors: [{ message: "Not authorized" }] }),
      }),
      sleep: async () => {},
    });

    const error = await client
      .request("query Projects { projects { edges { node { id } } } }")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SubstrateError);
    expect((error as SubstrateError).retryable).toBe(false);
    expect((error as SubstrateError).message).toContain("Not authorized");
  });

  it("treats a transport (network) failure as retryable", async () => {
    const sleeps: number[] = [];
    const client = new RailwayClient({
      token: "t",
      transport: async () => {
        throw new Error("ECONNRESET");
      },
      sleep: recordingSleep(sleeps),
    });

    const error = await client
      .request("query Projects { projects { edges { node { id } } } }")
      .catch((thrown: unknown) => thrown);

    expect((error as SubstrateError).retryable).toBe(true);
    expect(sleeps).toHaveLength(4);
  });

  it("authenticates with the workspace token against the v2 endpoint", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const client = new RailwayClient({
      token: "wt-secret",
      transport: async ({ url, headers }) => {
        seen.push({ url, headers });
        return { status: 200, body: JSON.stringify({ data: {} }) };
      },
      sleep: async () => {},
    });

    await client.request(
      "query Projects { projects { edges { node { id } } } }",
    );

    expect(seen[0]?.url).toBe(RAILWAY_API_URL);
    expect(seen[0]?.headers.Authorization).toBe("Bearer wt-secret");
  });

  it("uses the project-token header when asked", async () => {
    const seen: Record<string, string>[] = [];
    const client = new RailwayClient({
      token: "pt-secret",
      tokenHeader: "project",
      transport: async ({ headers }) => {
        seen.push(headers);
        return { status: 200, body: JSON.stringify({ data: {} }) };
      },
      sleep: async () => {},
    });

    await client.request(
      "query Projects { projects { edges { node { id } } } }",
    );

    expect(seen[0]?.["Project-Access-Token"]).toBe("pt-secret");
    expect(seen[0]?.Authorization).toBeUndefined();
  });
});

describe("RailwaySubstrate topology", () => {
  it("creates the org project once and reuses it for a second environment", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);

    const first = await provider.provisionStack(SPEC);
    const second = await provider.provisionStack({
      ...SPEC,
      stackId: "77777777-7777-4777-8777-777777777777",
      environmentName: "production",
    });

    expect(mock.projects.size).toBe(1);
    const createdName = [...mock.projects.values()][0]?.name;
    expect(createdName).toBe(`hs-org-${SPEC.organizationId.slice(0, 25)}`);
    // Railway rejects names past 32 characters ("Invalid project name",
    // observed live) — a full 32-char org id must still fit with the prefix.
    expect(createdName?.length).toBeLessThanOrEqual(32);
    expect(first.data.projectId).toBe(second.data.projectId);
    // Six services: redis/api/worker for each environment.
    expect([...mock.projects.values()][0]?.services.size).toBe(6);
    expect(mock.find("staging-redis")?.image).toBe("redis:8-alpine");
    // The migrations gate rides the app services and never the cache: an app
    // service that boots before migrations crash-loops on the schema guard.
    expect(mock.find("staging-api")?.preDeployCommand).toBe(
      "tsx scripts/migrate.ts",
    );
    expect(mock.find("staging-worker")?.preDeployCommand).toBe(
      "tsx scripts/migrate.ts",
    );
    expect(mock.find("staging-redis")?.preDeployCommand).toBeUndefined();
    // The worker is the only service whose start command is overridden — the
    // image's default CMD is the api process.
    expect(mock.find("staging-worker")?.startCommand).toBe(
      "node dist/worker.js",
    );
    expect(mock.find("staging-api")?.startCommand).toBeUndefined();
    // Both app services are told where the stack's cache lives; redis itself
    // gets no application env at all.
    expect(mock.find("staging-api")?.variables.REDIS_URL).toBe(
      "redis://staging-redis.railway.internal:6379",
    );
    expect(mock.find("staging-worker")?.variables.REDIS_URL).toBe(
      "redis://staging-redis.railway.internal:6379",
    );
    expect(mock.find("staging-redis")?.variables.REDIS_URL).toBeUndefined();
    expect(first.substrate).toBe(RAILWAY_SUBSTRATE_ID);
    expect(first.apiPublicUrl.startsWith("https://")).toBe(true);
  });

  it("maps the neutral region onto Railway's zones", async () => {
    const eu = new RailwayMock();
    await makeSubstrate(eu).provisionStack(SPEC);
    expect(eu.find("staging-api")?.region).toBe("europe-west4");

    const us = new RailwayMock();
    await makeSubstrate(us).provisionStack({ ...SPEC, region: "us" });
    expect(us.find("staging-api")?.region).toBe("us-west2");
  });

  it("gives the api service PORT and a generated domain, the worker neither", async () => {
    const mock = new RailwayMock();
    const refs = await makeSubstrate(mock).provisionStack(SPEC);

    expect(mock.find("staging-api")?.variables.PORT).toBe("3002");
    expect(mock.find("staging-worker")?.variables.PORT).toBeUndefined();
    expect(refs.apiPublicUrl).toBe(
      `https://${mock.find("staging-api")?.serviceDomain}`,
    );
  });

  it("deletes a null variable rather than writing an empty string", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);

    await provider.setEnv(refs, { LOG_LEVEL: null, EXTRA: "1" });

    expect(mock.operations).toContain("VariableDelete");
    expect(mock.find("staging-api")?.variables.LOG_LEVEL).toBeUndefined();
    expect(mock.find("staging-worker")?.variables.EXTRA).toBe("1");
  });

  it("suspends by scaling to zero and resumes to one replica", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);

    await provider.suspend(refs);
    expect(mock.find("staging-api")?.numReplicas).toBe(0);
    expect(mock.find("staging-redis")?.numReplicas).toBe(0);

    await provider.resume(refs);
    expect(mock.find("staging-api")?.numReplicas).toBe(1);
    expect(mock.find("staging-redis")?.numReplicas).toBe(1);
  });

  it("reports a failed deployment as unhealthy, naming the service", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);
    const worker = mock.find("staging-worker");
    if (!worker) throw new Error("mock: no worker");
    worker.deploymentStatus = "FAILED";

    const health = await provider.getHealth(refs);

    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("worker");
    // A per-service read of a healthy service is still healthy.
    expect(await provider.getHealth(refs, { service: "api" })).toMatchObject({
      healthy: true,
    });
  });

  it("counts a SLEEPING deployment as healthy", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);
    for (const name of ["staging-api", "staging-worker"]) {
      const service = mock.find(name);
      if (service) service.deploymentStatus = "SLEEPING";
    }

    expect((await provider.getHealth(refs)).healthy).toBe(true);
  });

  it("deploys an image with a pre-deploy command and redeploys that service", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);
    const before = mock.find("staging-api")?.deployCount ?? 0;

    await provider.deployImage(refs, {
      imageUrl: "ghcr.io/acme/app:sha",
      service: "api",
      preDeployCommand: "pnpm db:migrate",
    });

    const api = mock.find("staging-api");
    expect(api?.image).toBe("ghcr.io/acme/app:sha");
    expect(api?.preDeployCommand).toBe("pnpm db:migrate");
    expect(api?.deployCount).toBe(before + 1);
  });

  it("returns the CNAME and TXT records Railway requires for a custom domain", async () => {
    const provider = makeSubstrate();
    const refs = await provider.provisionStack(SPEC);

    const attachment = await provider.attachDomain(refs, "app.acme.test");

    expect(attachment.status).toBe("pending");
    expect(attachment.records.map((record) => record.type)).toEqual([
      "CNAME",
      "TXT",
    ]);
  });

  it("destroys the stack's services but keeps the org project", async () => {
    const mock = new RailwayMock();
    const provider = makeSubstrate(mock);
    const refs = await provider.provisionStack(SPEC);
    await provider.provisionStack({
      ...SPEC,
      stackId: "88888888-8888-4888-8888-888888888888",
      environmentName: "production",
    });

    await provider.destroyStack(refs);

    expect(mock.projects.size).toBe(1);
    expect(mock.find("staging-api")).toBeUndefined();
    expect(mock.find("production-api")).toBeTruthy();
  });
});

/**
 * The factory is the fail-closed boundary. Both `env` and the substrate
 * singleton are module state, so each case re-imports under a stubbed env.
 */
describe("getSubstrate with CLOUD_SUBSTRATE=railway", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadFactory(token?: string) {
    vi.resetModules();
    vi.stubEnv("CLOUD_SUBSTRATE", "railway");
    vi.stubEnv("CLOUD_RAILWAY_TOKEN", token ?? "");
    return import("../substrate/index");
  }

  it("refuses to build one without a token, never falling back to the fake", async () => {
    const { getSubstrate, FakeSubstrate } = await loadFactory();

    expect(() => getSubstrate()).toThrow(/CLOUD_RAILWAY_TOKEN/);
    expect(() => getSubstrate()).not.toBeInstanceOf(FakeSubstrate);
  });

  it("builds ONE RailwaySubstrate when the token is present", async () => {
    const { getSubstrate, RailwaySubstrate: Railway } =
      await loadFactory("wt-token");

    const first = getSubstrate();
    expect(first).toBeInstanceOf(Railway);
    expect(getSubstrate()).toBe(first);
  });
});
