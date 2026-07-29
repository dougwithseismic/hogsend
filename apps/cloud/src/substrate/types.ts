/**
 * THE seam (PRD 04 / DECISIONS §3).
 *
 * Every infrastructure operation the control plane performs goes through
 * `SubstrateProvider`. The point of the boundary is one-directional ignorance:
 * business logic (services, provisioning tasks, the dashboard) must never see a
 * Railway-shaped type, a GraphQL id, or a vendor error. It sees the neutral
 * types in this file and nothing else.
 *
 * Two rules keep it that way:
 *  - Every input and output here is a plain, portable value. A vendor's own
 *    identifiers live INSIDE `StackRefs.data`, which is opaque to callers: they
 *    store it, hand it back, and never read a key out of it.
 *  - Every method is async and single-object-in / result-object-out, so a new
 *    field is an additive change rather than a signature break — this interface
 *    is frozen early (PRD 08 deploys through it) and has to widen without
 *    churning callers.
 */

/** Region a stack's substrate lives in. Deliberately coarse: the tenant picks
 * a jurisdiction, not a cloud vendor's zone name. */
export type SubstrateRegion = "us" | "eu";

/** Shared cell (rung 1) vs. dedicated per-tenant infrastructure (rung 0). */
export type SubstrateTopology = "shared" | "dedicated";

/**
 * The two long-running processes of a Hogsend instance. Named here rather than
 * derived from the substrate so PRD 08 can deploy worker-then-api without the
 * seam growing a vendor's service-id vocabulary.
 */
export type SubstrateService = "api" | "worker";

/** Everything the substrate needs to bring a stack into existence. */
export interface StackSpec {
  /** The control-plane `stacks.id`. The substrate's naming/idempotency key. */
  stackId: string;
  organizationId: string;
  /** `production` | `staging` | `test` — the environment's name, for labels. */
  environmentName: string;
  region: SubstrateRegion;
  topology: SubstrateTopology;
  /**
   * The image the stack boots on before the customer's first publish — the
   * stock scaffold build (`hogsend-default:<engine-version>`). A tag string,
   * never a vendor deployment id.
   */
  initialImage: string;
  /**
   * Command run to completion before an app service's first boot — the
   * migrations gate. Without it the initial deploy boots the engine against an
   * EMPTY tenant database and the schema boot-guard crash-loops (found live
   * 2026-07-29). Applied to api and worker, never redis.
   */
  preDeployCommand?: string;
  /** Initial environment for every service in the stack. */
  env: Record<string, string>;
}

/**
 * The handle the control plane stores on `stacks.substrate_refs` and hands back
 * to every subsequent call.
 *
 * `data` is OPAQUE: only the implementation that produced it may read it. A
 * caller that reaches into `data` has re-coupled business logic to a vendor and
 * defeated the seam.
 *
 * `apiPublicUrl` is the one exception, and is REQUIRED because the provision
 * pipeline needs it before the stack can be considered configured: it becomes
 * the instance's `API_PUBLIC_URL` / `BETTER_AUTH_URL`. It is promoted out of
 * `data` precisely so callers never have to open the box to find it.
 */
export interface StackRefs {
  /** The implementation that owns this handle — `"fake"`, `"railway"`, … */
  substrate: string;
  /** The substrate-issued public origin of the `api` service. No trailing
   * slash. */
  apiPublicUrl: string;
  /** Vendor-private payload. Opaque to callers; persisted verbatim. */
  data: Record<string, unknown>;
}

/**
 * An environment patch. A `null` value UNSETS the variable; an absent key is
 * left alone. Merge semantics (rather than replace) because the pipeline sets
 * env in stages — tenant DSN, then Hatchet token, then provider keys — and a
 * later stage must not blank an earlier one.
 */
export type SubstrateEnvVars = Record<string, string | null>;

export interface RedeployOptions {
  /** Omitted → every service in the stack. */
  service?: SubstrateService;
}

export interface DeployImageOptions {
  /** A fully-qualified image reference, e.g. `ghcr.io/org/app:sha`. */
  imageUrl: string;
  service: SubstrateService;
  /**
   * Runs to completion before the new image takes traffic; the deploy fails if
   * it fails. This is how PRD 08 runs `db:migrate` ahead of the api cutover.
   */
  preDeployCommand?: string;
}

/** One DNS record the tenant must publish for a custom domain to verify. */
export interface DomainRecord {
  type: string;
  name: string;
  value: string;
}

export interface DomainAttachment {
  /** `pending` until the substrate observes the records; never assumed. */
  status: "pending" | "verified";
  records: DomainRecord[];
}

export interface HealthOptions {
  /** Omitted → the stack as a whole (every service must be healthy). */
  service?: SubstrateService;
}

export interface HealthResult {
  healthy: boolean;
  /** Human-readable reason. Present when unhealthy; free-form. */
  detail?: string;
}

/**
 * The frozen seam. Implementations: `FakeSubstrate` (deterministic, in-memory —
 * all tests + local dev) and `RailwaySubstrate` (PRD 04 task 5). Both must pass
 * `describeSubstrateContract`.
 */
export interface SubstrateProvider {
  /** Idempotent by `spec.stackId`: re-provisioning an existing stack returns
   * the same refs rather than creating a second one. */
  provisionStack(spec: StackSpec): Promise<StackRefs>;
  /** Tears down everything `provisionStack` created. After this, every other
   * method for these refs throws `SubstrateNotFoundError`. */
  destroyStack(refs: StackRefs): Promise<void>;
  setEnv(refs: StackRefs, vars: SubstrateEnvVars): Promise<void>;
  /** Restart on the current image. Safe to call repeatedly. */
  redeploy(refs: StackRefs, options?: RedeployOptions): Promise<void>;
  /**
   * Point a service at `imageUrl` and TRIGGER a rollout. Resolving means the
   * substrate accepted the request — NOT that the new containers are up: there
   * is deliberately no readiness read in this seam, so a caller that needs the
   * outcome must observe it (`getHealth`, the health sweep), never infer it
   * from this promise.
   */
  deployImage(refs: StackRefs, options: DeployImageOptions): Promise<void>;
  attachDomain(refs: StackRefs, domain: string): Promise<DomainAttachment>;
  getHealth(refs: StackRefs, options?: HealthOptions): Promise<HealthResult>;
  /** Stop the services, keep the state. Reversible with `resume`. */
  suspend(refs: StackRefs): Promise<void>;
  resume(refs: StackRefs): Promise<void>;
}

/**
 * The only error type that crosses the seam.
 *
 * `retryable` is the whole point: the provisioning pipeline decides between
 * "back off and try again" and "park the stack in `error`" from this flag
 * alone, so an implementation is the one place that knows a vendor's 429 from
 * its 422. Default `false` — an implementation must opt IN to a retry, because
 * retrying a permanent failure burns the pipeline's attempt budget for nothing.
 */
export class SubstrateError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The refs point at something the substrate does not have — destroyed, never
 * created, or created by a different substrate. Never retryable: waiting does
 * not make a deleted stack reappear.
 */
export class SubstrateNotFoundError extends SubstrateError {
  constructor(
    readonly resource: string,
    readonly id: string,
    options: { cause?: unknown } = {},
  ) {
    super(`${resource} "${id}" does not exist on the substrate`, {
      retryable: false,
      cause: options.cause,
    });
  }
}
