import {
  type DeployImageOptions,
  type DomainAttachment,
  type DomainRecord,
  type HealthOptions,
  type HealthResult,
  type RedeployOptions,
  type StackRefs,
  type StackSpec,
  type SubstrateEnvVars,
  SubstrateError,
  SubstrateNotFoundError,
  type SubstrateProvider,
  type SubstrateRegion,
  type SubstrateService,
} from "../types";
import { RailwayClient, type RailwayClientOptions } from "./client";
import * as Q from "./documents";

/**
 * The live substrate: Hogsend stacks on Railway (DECISIONS §3, PRD 04 task 5).
 *
 * ## Topology
 * One Railway PROJECT per organization, named `hs-org-<organizationId[:25]>`
 * (Railway caps project names at 32 characters — see {@link projectName}),
 * created lazily on the org's first stack. Inside it, each environment gets
 * three services named after the environment:
 *
 *   `<env>-redis`   `redis:8-alpine`, the engine's PostHog/property cache
 *   `<env>-api`     the HTTP process, on the stack's image, with a domain
 *   `<env>-worker`  the Hatchet worker, same image, no domain
 *
 * Everything else a stack needs — the tenant database and the Hatchet tenant —
 * lives on the region's SHARED cell, not here; this class only owns compute.
 *
 * A project rather than a Railway *environment* per stack because Railway
 * environments fork configuration from a base, which would make each new
 * Hogsend environment inherit the previous one's variables — the opposite of
 * what a control plane wants. Distinct services in one project keep the
 * per-stack env genuinely separate while still giving the org one billing and
 * one dashboard page.
 *
 * ## Idempotency
 * Every step is find-then-create against Railway's own state: a re-run of
 * `provisionStack` after a mid-way failure adopts what already exists rather
 * than building a second, orphaned copy that costs real money.
 *
 * ## What is NOT here
 * No business logic and no persistence: the control plane hands refs in and
 * gets neutral types out. Every vendor id lives inside `StackRefs.data`.
 */

export const RAILWAY_SUBSTRATE_ID = "railway";

/** Rung-1 Redis: the smallest useful cache, one per stack. */
const REDIS_IMAGE = "redis:8-alpine";

/** The port the scaffold's Dockerfile listens on. */
const API_PORT = "3002";

/**
 * The neutral region a tenant picked → the Railway zone it runs in
 * (DECISIONS §3). Coarse on purpose: a tenant chooses a jurisdiction, and the
 * mapping is the only place a zone name is allowed to appear.
 */
const REGION_ZONES: Record<SubstrateRegion, string> = {
  us: "us-west2",
  eu: "europe-west4",
};

/**
 * Deployment statuses that mean "this service is doing its job".
 *
 * `SLEEPING` is deliberately NOT here. App-sleep is disqualified for this
 * product: the worker has no inbound surface (`railway.worker.toml` declares
 * no port), so a sleeping worker never wakes and a journey's expired
 * multi-week `ctx.sleep` sits unclaimed. A sleeping service is therefore a
 * problem to surface, not a healthy state — the same verdict `getHealth`
 * already gives `numReplicas < 1` ("scaled to zero"), which this set used to
 * contradict.
 */
const HEALTHY_DEPLOYMENT_STATUSES = new Set(["SUCCESS"]);

/** The three services of a rung-1 stack; `redis` is infra, not a seam role. */
type StackServiceRole = SubstrateService | "redis";
const ALL_ROLES: StackServiceRole[] = ["redis", "api", "worker"];
const SEAM_SERVICES: SubstrateService[] = ["api", "worker"];

/** What we persist into `StackRefs.data`. Opaque to every caller. */
interface RailwayRefsData {
  projectId: string;
  environmentId: string;
  /** The Hogsend environment name — the prefix of every service name. */
  environmentName: string;
  serviceIds: Record<StackServiceRole, string>;
  region: SubstrateRegion;
}

/**
 * Pull credentials for a PRIVATE image registry, passed to Railway verbatim
 * (`RegistryCredentialsInput`) so a tenant service can pull the customer's
 * built image. This module's law applies with full force: the password is
 * NEVER logged, never audited, never persisted into `StackRefs.data` — it goes
 * onto the wire and nowhere else.
 */
export interface RailwayRegistryCredentials {
  username: string;
  password: string;
}

export type RailwaySubstrateOptions = RailwayClientOptions & {
  /** Set when tenant images live in a private registry; omitted → public. */
  registryCredentials?: RailwayRegistryCredentials;
};

export class RailwaySubstrate implements SubstrateProvider {
  private readonly client: RailwayClient;
  private readonly registryCredentials?: RailwayRegistryCredentials;

  constructor(
    options:
      | RailwaySubstrateOptions
      | {
          client: RailwayClient;
          registryCredentials?: RailwayRegistryCredentials;
        },
  ) {
    this.client =
      "client" in options ? options.client : new RailwayClient(options);
    this.registryCredentials = options.registryCredentials;
  }

  /**
   * Registry credentials for pulling an APP image — and only an app image.
   * Redis pulls `redis:8-alpine` from Docker Hub; attaching credentials for a
   * different registry to that pull is at best noise and at worst a failed
   * auth against the wrong host.
   */
  private appRegistryCredentials(): {
    registryCredentials?: RailwayRegistryCredentials;
  } {
    return this.registryCredentials
      ? { registryCredentials: this.registryCredentials }
      : {};
  }

  // -------------------------------------------------------------------------
  // Provision
  // -------------------------------------------------------------------------

  async provisionStack(spec: StackSpec): Promise<StackRefs> {
    const projectId = await this.ensureProject(spec.organizationId);
    const environmentId = await this.defaultEnvironment(projectId);

    const existing = await this.listServices(projectId);
    const serviceIds = {} as Record<StackServiceRole, string>;
    for (const role of ALL_ROLES) {
      const name = serviceName(spec.environmentName, role);
      serviceIds[role] =
        existing.get(name) ??
        (await this.createService({
          projectId,
          name,
          image: role === "redis" ? REDIS_IMAGE : spec.initialImage,
          // The app image may live in a private registry; redis never does.
          ...(role === "redis" ? {} : this.appRegistryCredentials()),
        }));
      await this.updateInstance(serviceIds[role], environmentId, {
        region: REGION_ZONES[spec.region],
        // Also set on the instance config (not just ServiceCreateInput) so an
        // ADOPTED service — one a prior half-run created before credentials
        // were configured — gains pull access on the re-run.
        ...(role === "redis" ? {} : this.appRegistryCredentials()),
        // The migrations gate: app services must not boot an empty tenant
        // database. Redis is a cache and gets no application concerns.
        ...(role !== "redis" && spec.preDeployCommand
          ? { preDeployCommand: spec.preDeployCommand }
          : {}),
        // The image's default CMD is the api; the worker must be told it is
        // the worker or the stack runs two apis and zero journey executors.
        ...(role === "worker" && spec.workerStartCommand
          ? { startCommand: spec.workerStartCommand }
          : {}),
      });
    }

    // Redis gets no application env: it is a cache, and shipping the tenant's
    // DSN + secrets into a third container widens the blast radius for free.
    // The app services DO get the cache's address — it is Railway-internal
    // (`<service>.railway.internal`), so only this substrate can know it.
    const redisUrl = `redis://${serviceName(spec.environmentName, "redis")}.railway.internal:6379`;
    await this.upsertVariables(projectId, environmentId, serviceIds.api, {
      ...spec.env,
      PORT: API_PORT,
      REDIS_URL: redisUrl,
    });
    await this.upsertVariables(projectId, environmentId, serviceIds.worker, {
      ...spec.env,
      REDIS_URL: redisUrl,
    });

    const domain = await this.ensureServiceDomain(
      projectId,
      environmentId,
      serviceIds.api,
    );

    const data: RailwayRefsData = {
      projectId,
      environmentId,
      environmentName: spec.environmentName,
      serviceIds,
      region: spec.region,
    };
    return {
      substrate: RAILWAY_SUBSTRATE_ID,
      apiPublicUrl: `https://${domain}`,
      data: { ...data },
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async setEnv(refs: StackRefs, vars: SubstrateEnvVars): Promise<void> {
    const data = await this.resolve(refs);

    const upserts: Record<string, string> = {};
    const deletes: string[] = [];
    for (const [key, value] of Object.entries(vars)) {
      if (value === null) deletes.push(key);
      else upserts[key] = value;
    }

    for (const service of SEAM_SERVICES) {
      const serviceId = data.serviceIds[service];
      if (Object.keys(upserts).length > 0) {
        await this.upsertVariables(
          data.projectId,
          data.environmentId,
          serviceId,
          upserts,
        );
      }
      for (const name of deletes) {
        await this.deleteVariable(
          data.projectId,
          data.environmentId,
          serviceId,
          name,
        );
      }
    }
  }

  async redeploy(refs: StackRefs, options?: RedeployOptions): Promise<void> {
    const data = await this.resolve(refs);
    for (const service of servicesFor(options?.service)) {
      await this.redeployService(data.serviceIds[service], data.environmentId);
    }
  }

  async deployImage(
    refs: StackRefs,
    options: DeployImageOptions,
  ): Promise<void> {
    const data = await this.resolve(refs);
    const serviceId = data.serviceIds[options.service];

    await this.updateInstance(serviceId, data.environmentId, {
      source: { image: options.imageUrl },
      ...this.appRegistryCredentials(),
      ...(options.preDeployCommand
        ? { preDeployCommand: options.preDeployCommand }
        : {}),
    });
    // `serviceInstanceUpdate` only changes CONFIGURATION; nothing rolls until
    // a deploy is asked for.
    await this.redeployService(serviceId, data.environmentId);
  }

  async attachDomain(
    refs: StackRefs,
    domain: string,
  ): Promise<DomainAttachment> {
    const data = await this.resolve(refs);

    const result = await this.client.request<{
      customDomainCreate: {
        domain: string;
        status?: {
          dnsRecords?: {
            recordType: string;
            hostlabel: string;
            requiredValue: string;
            zone?: string;
          }[];
        };
      };
    }>(Q.CUSTOM_DOMAIN_CREATE, {
      input: {
        projectId: data.projectId,
        environmentId: data.environmentId,
        serviceId: data.serviceIds.api,
        domain,
      },
    });

    const records: DomainRecord[] = (
      result.customDomainCreate.status?.dnsRecords ?? []
    ).map((record) => ({
      type: record.recordType,
      name: record.hostlabel || domain,
      value: record.requiredValue,
    }));

    if (records.length === 0) {
      // Railway occasionally answers before it has computed the records.
      //
      // Re-query rather than synthesize. A custom domain needs BOTH a CNAME and
      // an ownership TXT — Railway 404s a domain whose TXT is missing, and it
      // keeps doing so after the CNAME resolves — so the CNAME we could compute
      // ourselves is exactly half of the answer. Publishing that half looks
      // like success and never verifies.
      records.push(
        ...(await this.readCustomDomainRecords(
          data.projectId,
          data.environmentId,
          data.serviceIds.api,
          domain,
        )),
      );
    }

    // ALWAYS pending: Railway has not seen the tenant's DNS yet, and claiming
    // otherwise would let the dashboard lie about a domain that never resolves.
    return { status: "pending", records };
  }

  /**
   * The records one custom domain is still waiting on, read back from Railway.
   *
   * Returns whatever Railway has — including nothing, if it still has not
   * computed them. An empty result is honest and the caller can retry; a
   * fabricated one is not.
   */
  private async readCustomDomainRecords(
    projectId: string,
    environmentId: string,
    serviceId: string,
    domain: string,
  ): Promise<DomainRecord[]> {
    const result = await this.client.request<{
      domains: {
        customDomains?: {
          domain: string;
          status?: {
            dnsRecords?: {
              recordType: string;
              hostlabel: string;
              requiredValue: string;
              zone?: string;
            }[];
          };
        }[];
      };
    }>(Q.CUSTOM_DOMAINS, { projectId, environmentId, serviceId });

    const match = (result.domains.customDomains ?? []).find(
      (entry) => entry.domain === domain,
    );
    return (match?.status?.dnsRecords ?? []).map((record) => ({
      type: record.recordType,
      name: record.hostlabel || domain,
      value: record.requiredValue,
    }));
  }

  async getHealth(
    refs: StackRefs,
    options?: HealthOptions,
  ): Promise<HealthResult> {
    const data = await this.resolve(refs);

    const details: string[] = [];
    for (const service of servicesFor(options?.service)) {
      const instance = await this.instanceStatus(
        data.serviceIds[service],
        data.environmentId,
      );
      const replicas = instance.numReplicas ?? 1;
      const status = instance.latestDeployment?.status ?? "UNKNOWN";
      if (replicas < 1) {
        details.push(`${service}: scaled to zero (suspended)`);
      } else if (!HEALTHY_DEPLOYMENT_STATUSES.has(status)) {
        details.push(`${service}: ${status}`);
      }
    }

    if (details.length > 0) {
      return { healthy: false, detail: details.join("; ") };
    }
    return { healthy: true };
  }

  /**
   * SUSPEND = scale to zero.
   *
   * Railway has no public pause mutation for a service instance (the Go CLI
   * never had one either, and `serviceInstanceUpdate` is what the public
   * schema exposes), so the honest implementation is `numReplicas: 0` on every
   * service in the stack, redis included: a suspended tenant should cost
   * nothing. State survives — Railway keeps the service, its variables, its
   * domain and its volumes — which is exactly the "stop the services, keep the
   * state" the seam asks for.
   */
  async suspend(refs: StackRefs): Promise<void> {
    await this.scale(refs, 0);
  }

  async resume(refs: StackRefs): Promise<void> {
    await this.scale(refs, 1);
  }

  /**
   * Deletes the stack's three services and KEEPS the org project: another
   * environment of the same organization almost certainly lives in it, and
   * `projectDelete` would take those with it. The empty project is harmless
   * and is what the next environment adopts.
   */
  async destroyStack(refs: StackRefs): Promise<void> {
    const data = await this.resolve(refs);
    for (const role of ALL_ROLES) {
      await this.client.request(Q.SERVICE_DELETE, {
        id: data.serviceIds[role],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Railway primitives
  // -------------------------------------------------------------------------

  private async ensureProject(organizationId: string): Promise<string> {
    const name = projectName(organizationId);

    const listed = await this.client.request<{
      projects: { edges: { node: { id: string; name: string } }[] };
    }>(Q.PROJECTS);
    const found = listed.projects.edges.find((edge) => edge.node.name === name)
      ?.node.id;
    if (found) return found;

    const created = await this.client.request<{
      projectCreate: { id: string };
    }>(Q.PROJECT_CREATE, {
      input: {
        name,
        ...(this.client.workspaceId
          ? { workspaceId: this.client.workspaceId }
          : {}),
      },
    });
    return created.projectCreate.id;
  }

  /**
   * A fresh Railway project has exactly one environment (`production`). We use
   * it for every Hogsend environment of the org — see the class note: Railway
   * environments fork config, which is the wrong isolation for this.
   */
  private async defaultEnvironment(projectId: string): Promise<string> {
    const result = await this.client.request<{
      environments: { edges: { node: { id: string; name: string } }[] };
    }>(Q.PROJECT_ENVIRONMENTS, { projectId });

    const nodes = result.environments.edges.map((edge) => edge.node);
    const chosen = nodes.find((node) => node.name === "production") ?? nodes[0];
    if (!chosen) {
      throw new SubstrateError(
        `Railway project ${projectId} has no environment to deploy into`,
        { retryable: false },
      );
    }
    return chosen.id;
  }

  private async listServices(projectId: string): Promise<Map<string, string>> {
    const result = await this.client.request<{
      project: {
        services: { edges: { node: { id: string; name: string } }[] };
      };
    }>(Q.PROJECT_SERVICES, { projectId });

    return new Map(
      result.project.services.edges.map((edge) => [
        edge.node.name,
        edge.node.id,
      ]),
    );
  }

  private async createService(input: {
    projectId: string;
    name: string;
    image: string;
    registryCredentials?: RailwayRegistryCredentials;
  }): Promise<string> {
    const result = await this.client.request<{
      serviceCreate: { id: string };
    }>(Q.SERVICE_CREATE, {
      input: {
        projectId: input.projectId,
        name: input.name,
        source: { image: input.image },
        ...(input.registryCredentials
          ? { registryCredentials: input.registryCredentials }
          : {}),
      },
    });
    return result.serviceCreate.id;
  }

  private async updateInstance(
    serviceId: string,
    environmentId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.client.request(Q.SERVICE_INSTANCE_UPDATE, {
      serviceId,
      environmentId,
      input: patch,
    });
  }

  private async redeployService(
    serviceId: string,
    environmentId: string,
  ): Promise<void> {
    await this.client.request(Q.SERVICE_INSTANCE_REDEPLOY, {
      serviceId,
      environmentId,
    });
  }

  private async instanceStatus(
    serviceId: string,
    environmentId: string,
  ): Promise<{
    numReplicas?: number | null;
    latestDeployment?: { status?: string } | null;
  }> {
    const result = await this.client.request<{
      serviceInstance: {
        numReplicas?: number | null;
        latestDeployment?: { status?: string } | null;
      } | null;
    }>(Q.SERVICE_INSTANCE_STATUS, { serviceId, environmentId });
    return result.serviceInstance ?? {};
  }

  private async upsertVariables(
    projectId: string,
    environmentId: string,
    serviceId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    await this.client.request(Q.VARIABLE_COLLECTION_UPSERT, {
      input: {
        projectId,
        environmentId,
        serviceId,
        // MERGE, not replace: Railway upserts the collection, so a later
        // pipeline stage adding HATCHET_* must not blank the DSN an earlier
        // one wrote.
        replace: false,
        variables,
      },
    });
  }

  private async deleteVariable(
    projectId: string,
    environmentId: string,
    serviceId: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.request(Q.VARIABLE_DELETE, {
        input: { projectId, environmentId, serviceId, name },
      });
    } catch (error) {
      // Unsetting a variable that was never set is a NO-OP, not a failure: the
      // seam's contract says so, and the pipeline unsets keys it cannot know
      // the history of.
      if (isNotFound(error)) return;
      throw error;
    }
  }

  private async ensureServiceDomain(
    projectId: string,
    environmentId: string,
    serviceId: string,
  ): Promise<string> {
    const existing = await this.client.request<{
      domains: { serviceDomains: { domain: string }[] };
    }>(Q.SERVICE_DOMAINS, { projectId, environmentId, serviceId });
    const found = existing.domains.serviceDomains[0]?.domain;
    if (found) return found;

    // ServiceDomainCreateInput takes environmentId/serviceId/targetPort ONLY.
    // Railway answers an unknown input field with a bare HTTP 400 "Problem
    // processing request" rather than a field error, so a stray projectId here
    // reads as an API outage. Do not add one back.
    const created = await this.client.request<{
      serviceDomainCreate: { domain: string };
    }>(Q.SERVICE_DOMAIN_CREATE, {
      input: { environmentId, serviceId, targetPort: Number(API_PORT) },
    });
    return created.serviceDomainCreate.domain;
  }

  private async scale(refs: StackRefs, numReplicas: number): Promise<void> {
    const data = await this.resolve(refs);
    for (const role of ALL_ROLES) {
      await this.updateInstance(data.serviceIds[role], data.environmentId, {
        numReplicas,
      });
    }
    // Replica count is configuration; a deploy is what applies it.
    for (const service of SEAM_SERVICES) {
      await this.redeployService(data.serviceIds[service], data.environmentId);
    }
  }

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /**
   * Read the opaque handle AND confirm the stack still exists on Railway.
   *
   * The confirmation is the point: the contract requires every post-destroy
   * call to be a `SubstrateNotFoundError`, and it is also the truthful answer
   * when someone deleted the services from the Railway dashboard. One extra
   * query per operation is a cheap price for never reporting a healthy stack
   * that is not there.
   */
  private async resolve(refs: StackRefs): Promise<RailwayRefsData> {
    const data = refs.data as Partial<RailwayRefsData> | undefined;
    const serviceIds = data?.serviceIds;
    if (
      typeof data?.projectId !== "string" ||
      typeof data.environmentId !== "string" ||
      typeof serviceIds?.api !== "string" ||
      typeof serviceIds.worker !== "string"
    ) {
      throw new SubstrateNotFoundError(
        "Stack",
        String(data?.projectId ?? "unknown"),
      );
    }

    let live: Map<string, string>;
    try {
      live = await this.listServices(data.projectId);
    } catch (error) {
      if (isNotFound(error)) {
        throw new SubstrateNotFoundError("Project", data.projectId, {
          cause: error,
        });
      }
      throw error;
    }

    const alive = new Set(live.values());
    if (!alive.has(serviceIds.api) || !alive.has(serviceIds.worker)) {
      throw new SubstrateNotFoundError("Stack", serviceIds.api);
    }

    return data as RailwayRefsData;
  }
}

/**
 * The org's project name — the substrate's own idempotency key.
 *
 * Railway rejects project names longer than 32 characters ("Invalid project
 * name", found live 2026-07-29), and org ids are themselves 32 characters, so
 * the id is truncated to fit the `hs-org-` prefix. A 25-character prefix of a
 * random base62 id keeps collisions out of reach while the name stays
 * recognizably the org's id in the Railway UI. Deterministic — lazy
 * find-or-create keys on exactly this string — so NEVER change the scheme once
 * live tenant projects exist.
 */
function projectName(organizationId: string): string {
  return `hs-org-${organizationId.slice(0, 25)}`;
}

function serviceName(environmentName: string, role: StackServiceRole): string {
  return `${environmentName}-${role}`;
}

function servicesFor(service?: SubstrateService): SubstrateService[] {
  return service ? [service] : SEAM_SERVICES;
}

/** Railway reports a missing resource as a plain GraphQL message. */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof SubstrateError &&
    /not[ _]?found|does not exist|no such/i.test(error.message)
  );
}
