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
 * problem to surface, not a healthy state.
 *
 * App-sleep is doubly wrong for suspend specifically: a sleeping service WAKES
 * on any inbound request, so a tenant paused for non-payment would un-pause
 * themselves by loading their own URL.
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

/** One custom domain as Railway's `domains` query describes it. */
interface RailwayCustomDomain {
  id?: string;
  domain: string;
  status?: {
    verified?: boolean;
    certificateStatus?: string;
    certificateRetryable?: boolean | null;
    certificateErrorMessage?: string | null;
    /** The ownership TXT, which Railway keeps OUT of `dnsRecords`. */
    verificationDnsHost?: string | null;
    verificationToken?: string | null;
    dnsRecords?: {
      recordType: string;
      hostlabel: string;
      requiredValue: string;
      zone?: string;
    }[];
  };
}

/**
 * Railway reports record types as a prefixed enum — `DNS_RECORD_TYPE_CNAME`,
 * `DNS_RECORD_TYPE_TXT` — not as the DNS type itself. Confirmed live against
 * the control plane's own `cloud.hogsend.com` domain.
 *
 * `DomainRecord.type` is the DNS type by contract, because that is what a DNS
 * provider is handed verbatim. Passing the enum through would make Cloudflare
 * reject the write with an opaque 400, and the hostname would silently never
 * resolve.
 */
function normalizeRecordType(recordType: string): string {
  return recordType.replace(/^DNS_RECORD_TYPE_/, "").toUpperCase();
}

/**
 * Railway reports a record's name in TWO fields — `hostlabel` (the label alone,
 * e.g. `acme-staging`) and `zone` (e.g. `hogsend.app`) — and a caller that
 * publishes the label as if it were the name writes a record outside the zone.
 * Found live: the DNS client correctly refused
 * `"withseismic-hostcheck" is not inside the zone "hogsend.app"`.
 *
 * `DomainRecord.name` is fully qualified by contract, so the qualification
 * happens HERE, at the vendor boundary, rather than in every caller.
 */
function qualifyRecordName(
  record: { hostlabel?: string; zone?: string },
  domain: string,
): string {
  const label = record.hostlabel?.trim();
  const zone = record.zone?.trim();
  if (!label) return domain;
  // Already qualified (some records come back whole), or no zone to append.
  if (!zone || label === zone || label.endsWith(`.${zone}`)) return label;
  return `${label}.${zone}`;
}

/**
 * Every record a custom domain needs, from Railway's TWO separate answers.
 *
 * `status.dnsRecords` carries only the routing CNAME. The ownership TXT lives
 * in `status.verificationDnsHost` + `status.verificationToken` and is NOT in
 * `dnsRecords` — confirmed live, and the cause of a stall that looked like
 * nothing at all: without the TXT, `verified` stays false forever, no
 * certificate is ever issued, and the hostname simply never serves. There is no
 * error anywhere; the domain just sits in `VALIDATING_OWNERSHIP`.
 *
 * So the TXT is synthesized HERE, at the vendor boundary. `DomainRecord[]` is
 * "everything you must publish" by contract, and a caller must not have to know
 * that this vendor splits the answer across two shapes.
 */
function collectDomainRecords(
  status: RailwayCustomDomain["status"],
  domain: string,
): DomainRecord[] {
  const records: DomainRecord[] = (status?.dnsRecords ?? []).map((record) => ({
    type: normalizeRecordType(record.recordType),
    name: qualifyRecordName(record, domain),
    value: record.requiredValue,
  }));

  const host = status?.verificationDnsHost?.trim();
  const token = status?.verificationToken?.trim();
  if (!host || !token) return records;

  // `verificationDnsHost` is a LABEL (`_railway-verify.acme-staging`), like
  // `hostlabel`. Borrow the zone the CNAME came back with; failing that, derive
  // it from the domain by dropping its own leading label.
  const zone =
    status?.dnsRecords?.find((record) => record.zone?.trim())?.zone?.trim() ??
    domain.split(".").slice(1).join(".");
  const name = qualifyRecordName({ hostlabel: host, zone }, domain);

  // Never a duplicate: an already-listed TXT wins over the synthesized one.
  if (records.some((record) => record.type === "TXT" && record.name === name)) {
    return records;
  }
  records.push({ type: "TXT", name, value: token });
  return records;
}

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
          // Redis boots now: it is a cache, it takes no application config, and
          // the app services need its address the moment they start. The app
          // services get NO image here on purpose — `serviceCreate` with a
          // source deploys IMMEDIATELY, and their env does not exist yet. They
          // are given an image by `deployImage`, once `setEnv` has run.
          ...(role === "redis" ? { image: REDIS_IMAGE } : {}),
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
    // `serviceInstanceUpdate` MAY roll a deploy by itself (it does when the
    // source changes — verified against live deployment records, `reason:
    // "deploy"`, 2026-08-04), but it is not documented to and it does not when
    // the patch is a no-op. Asking explicitly is the only way to know a deploy
    // happened, and a redundant redeploy is cheap next to a silent no-op.
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

    const records = collectDomainRecords(
      result.customDomainCreate.status,
      domain,
    );

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

  async checkDomain(
    refs: StackRefs,
    domain: string,
  ): Promise<DomainAttachment> {
    const data = await this.resolve(refs);
    const match = await this.readCustomDomain(
      data.projectId,
      data.environmentId,
      data.serviceIds.api,
      domain,
    );
    if (!match) {
      throw new SubstrateNotFoundError("Domain", domain);
    }

    const status = match.status;
    // Terminal, and told apart from the slow-but-fine states on purpose: a
    // caller polling to a deadline would otherwise burn its whole budget on a
    // verdict Railway has already reached.
    if (status?.certificateStatus === Q.CERTIFICATE_FAILED) {
      const reason =
        status.certificateErrorMessage ?? "no reason given by the substrate";
      throw new SubstrateError(
        `certificate for ${domain} failed to issue: ${reason}`,
        // Railway's own read on whether ANOTHER attempt could differ. Absent is
        // read as permanent — the safe direction, since a wrong `false` parks a
        // stack a human then looks at, while a wrong `true` spins in silence.
        { retryable: status.certificateRetryable === true },
      );
    }

    const records = collectDomainRecords(status, domain);

    // BOTH halves. `verified` alone means Railway has seen the DNS, which says
    // nothing about whether a TLS handshake would succeed.
    const ready =
      status?.verified === true &&
      status?.certificateStatus === Q.CERTIFICATE_VALID;

    return { status: ready ? "verified" : "pending", records };
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
    const match = await this.readCustomDomain(
      projectId,
      environmentId,
      serviceId,
      domain,
    );
    return collectDomainRecords(match?.status, domain);
  }

  /** One custom domain as Railway currently describes it, or undefined. */
  private async readCustomDomain(
    projectId: string,
    environmentId: string,
    serviceId: string,
    domain: string,
  ): Promise<RailwayCustomDomain | undefined> {
    const result = await this.client.request<{
      domains: { customDomains?: RailwayCustomDomain[] };
    }>(Q.CUSTOM_DOMAINS, { projectId, environmentId, serviceId });

    return (result.domains.customDomains ?? []).find(
      (entry) => entry.domain === domain,
    );
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
      // NO deployment at all is what a suspended service looks like now.
      // Confirmed live: after `deploymentRemove`, `latestDeployment` is null —
      // Railway does not report a "removed" status to read instead.
      if (!instance.latestDeployment) {
        details.push(`${service}: no deployment (suspended)`);
        continue;
      }
      const status = instance.latestDeployment.status ?? "UNKNOWN";
      if (!HEALTHY_DEPLOYMENT_STATUSES.has(status)) {
        details.push(`${service}: ${status}`);
      }
    }

    if (details.length > 0) {
      return { healthy: false, detail: details.join("; ") };
    }
    return { healthy: true };
  }

  /**
   * SUSPEND = remove each service's deployment.
   *
   * Railway REMOVED scale-to-zero: `numReplicas: 0` and a zeroed
   * `multiRegionConfig` are both refused with "Number must be greater than or
   * equal to 1" (found live 2026-08-04, breaking suspend and — because destroy
   * requires a suspended stack — destroy with it).
   *
   * `deploymentRemove` is Railway's own answer to pausing a service: it tears
   * the container down and "halts any further project resource consumption",
   * while the service, its variables, its domains and its instance config all
   * survive. That is exactly the seam's "stop the services, keep the state",
   * and it is what makes suspend worth having — a suspended tenant costs
   * nothing.
   *
   * Redis is suspended too: a paused tenant should cost nothing anywhere.
   *
   * Idempotent twice over — a service with no deployment is skipped, and
   * `deploymentRemove` on an already-removed id returns true (both confirmed
   * live). That skip is also the partial-failure story: if the third service
   * fails, the stack stays honestly `running`, and a retry passes over the two
   * already removed and finishes the third.
   */
  async suspend(refs: StackRefs): Promise<void> {
    const data = await this.resolve(refs);
    // API first: stop taking traffic before stopping the thing that serves it.
    for (const role of ["api", "worker", "redis"] as StackServiceRole[]) {
      const instance = await this.instanceStatus(
        data.serviceIds[role],
        data.environmentId,
      );
      const deploymentId = instance.latestDeployment?.id;
      if (!deploymentId) continue;
      await this.client.request(Q.DEPLOYMENT_REMOVE, { id: deploymentId });
    }
  }

  /**
   * RESUME = redeploy each service.
   *
   * `serviceInstanceRedeploy` works from a fully-removed state (confirmed
   * live: `latestDeployment` null → redeploy → a new SUCCESS deployment), and
   * it brings the service back on ITS OWN configured image — which
   * `deployImage` keeps pointed at the customer's published build. That is the
   * property that matters: a resumed stack must not come back on the stock
   * scaffold.
   *
   * ALL three services, not just the seam pair. The previous implementation
   * scaled all three but only redeployed api and worker, so a redis suspended
   * this way would never have come back.
   */
  async resume(refs: StackRefs): Promise<void> {
    const data = await this.resolve(refs);
    // Redis first: the api and worker expect their cache to be there.
    for (const role of ["redis", "api", "worker"] as StackServiceRole[]) {
      await this.redeployService(data.serviceIds[role], data.environmentId);
    }
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

  /**
   * Create a service, optionally with a source image.
   *
   * Passing `image` makes Railway deploy it THERE AND THEN — which is why it is
   * optional. A service created without one is inert until something sets its
   * source, so it can be configured and given variables in peace.
   */
  private async createService(input: {
    projectId: string;
    name: string;
    image?: string;
    registryCredentials?: RailwayRegistryCredentials;
  }): Promise<string> {
    const result = await this.client.request<{
      serviceCreate: { id: string };
    }>(Q.SERVICE_CREATE, {
      input: {
        projectId: input.projectId,
        name: input.name,
        ...(input.image ? { source: { image: input.image } } : {}),
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
    latestDeployment?: { id?: string; status?: string } | null;
  }> {
    const result = await this.client.request<{
      serviceInstance: {
        latestDeployment?: { id?: string; status?: string } | null;
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
