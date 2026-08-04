import {
  type DeployImageOptions,
  type DomainAttachment,
  type HealthOptions,
  type HealthResult,
  type RedeployOptions,
  type StackRefs,
  type StackSpec,
  type SubstrateEnvVars,
  SubstrateError,
  SubstrateNotFoundError,
  type SubstrateProvider,
  type SubstrateService,
} from "./types";

/**
 * The in-memory substrate: every control-plane test and all of local dev.
 *
 * It is DETERMINISTIC by construction — no `Date.now()`, no randomness, no
 * timers, no sleeps. Every name it issues is derived from the stack id, so a
 * test that asserts a URL is asserting a fact rather than recording a sample,
 * and a run's failure is reproducible from its inputs alone.
 *
 * Two affordances exist for tests only:
 *  - `failNext(method, error?)` scripts the NEXT call to that method to throw.
 *    Retry/backoff behaviour in the provisioning pipeline is a rule that has to
 *    be provable, and the only honest way to prove it is to make the substrate
 *    fail on cue. Default is a RETRYABLE `SubstrateError`, because that is the
 *    interesting case; pass an explicit error for the permanent one.
 *  - `calls` records `{ method, args }` in order, so a test can assert
 *    idempotency the strong way — "the second run did NOT call
 *    `provisionStack` again" — instead of only checking the end state.
 */

interface FakeServiceState {
  image: string;
  env: Record<string, string>;
  running: boolean;
  /** Counts deploys + redeploys; lets a test see a restart that changed
   * nothing observable otherwise. */
  deployCount: number;
  lastPreDeployCommand?: string;
}

interface FakeDomainState {
  domain: string;
  status: DomainAttachment["status"];
  records: DomainAttachment["records"];
}

interface FakeStackState {
  spec: StackSpec;
  services: Record<SubstrateService, FakeServiceState>;
  domains: FakeDomainState[];
  suspended: boolean;
  /** Set by `setUnhealthy` — a running stack that is nonetheless sick, which
   * is what the health-poll alert path (PRD 04 task 4) needs to exercise. */
  unhealthy: boolean;
}

/** Every method name a test may script a failure for. */
export type FakeSubstrateMethod = keyof SubstrateProvider;

export interface FakeSubstrateCall {
  method: FakeSubstrateMethod;
  args: unknown[];
}

const SERVICES: SubstrateService[] = ["api", "worker"];

export const FAKE_SUBSTRATE_ID = "fake";

/** Stable, offline, obviously-not-real. `.localhost` resolves nowhere useful
 * on purpose: a leak into a live code path fails immediately. */
export function fakeApiPublicUrl(stackId: string): string {
  return `http://fake.${stackId}.localhost`;
}

export class FakeSubstrate implements SubstrateProvider {
  private readonly stacks = new Map<string, FakeStackState>();
  private readonly scriptedFailures = new Map<
    FakeSubstrateMethod,
    SubstrateError[]
  >();

  /** Every call made, in order. Cleared with `reset()`. */
  readonly calls: FakeSubstrateCall[] = [];

  /**
   * Script the next call to `method` to throw. Queues, so two calls script two
   * consecutive failures. Default error is retryable — the pipeline is supposed
   * to survive it.
   */
  failNext(method: FakeSubstrateMethod, error?: SubstrateError): this {
    const queue = this.scriptedFailures.get(method) ?? [];
    queue.push(
      error ??
        new SubstrateError(`fake substrate: scripted failure in ${method}`, {
          retryable: true,
        }),
    );
    this.scriptedFailures.set(method, queue);
    return this;
  }

  /** Make a provisioned, running stack report unhealthy. */
  setUnhealthy(refs: StackRefs, unhealthy = true): this {
    this.mustGet(refs).unhealthy = unhealthy;
    return this;
  }

  /** Mark an attached domain verified — the DNS the tenant would publish. */
  verifyDomain(refs: StackRefs, domain: string): this {
    const state = this.mustGet(refs);
    const entry = state.domains.find((d) => d.domain === domain);
    if (!entry) throw new SubstrateNotFoundError("Domain", domain);
    entry.status = "verified";
    return this;
  }

  /** Drop all state and the call log. */
  reset(): this {
    this.stacks.clear();
    this.scriptedFailures.clear();
    this.calls.length = 0;
    return this;
  }

  /** Test-only read of stack state; the harness's `inspect`. */
  snapshot(refs: StackRefs): FakeStackSnapshot {
    const state = this.mustGet(refs);
    return {
      services: {
        api: {
          image: state.services.api.image,
          running: state.services.api.running,
        },
        worker: {
          image: state.services.worker.image,
          running: state.services.worker.running,
        },
      },
      env: {
        api: { ...state.services.api.env },
        worker: { ...state.services.worker.env },
      },
    };
  }

  async provisionStack(spec: StackSpec): Promise<StackRefs> {
    this.record("provisionStack", [spec]);

    const existing = this.stacks.get(spec.stackId);
    // Idempotent by stack id: the pipeline re-runs its steps after a transient
    // failure, and a second stack would be real money plus an orphan.
    if (!existing) {
      this.stacks.set(spec.stackId, {
        spec,
        services: {
          api: newService(spec),
          worker: newService(spec),
        },
        domains: [],
        suspended: false,
        unhealthy: false,
      });
    }

    return {
      substrate: FAKE_SUBSTRATE_ID,
      apiPublicUrl: fakeApiPublicUrl(spec.stackId),
      data: { stackId: spec.stackId, region: spec.region },
    };
  }

  async destroyStack(refs: StackRefs): Promise<void> {
    this.record("destroyStack", [refs]);
    const state = this.mustGet(refs);
    this.stacks.delete(state.spec.stackId);
  }

  async setEnv(refs: StackRefs, vars: SubstrateEnvVars): Promise<void> {
    this.record("setEnv", [refs, vars]);
    const state = this.mustGet(refs);
    for (const service of SERVICES) {
      const env = state.services[service].env;
      for (const [key, value] of Object.entries(vars)) {
        // MERGE, not replace: the pipeline sets env in stages, and a later
        // stage must not blank the DSN an earlier one wrote.
        if (value === null) delete env[key];
        else env[key] = value;
      }
    }
  }

  async redeploy(refs: StackRefs, options?: RedeployOptions): Promise<void> {
    this.record("redeploy", [refs, options]);
    const state = this.mustGet(refs);
    for (const service of servicesFor(options?.service)) {
      state.services[service].deployCount += 1;
      // A redeploy BRINGS A SERVICE UP, including a suspended one — because on
      // the real substrate redeploy IS the resume mechanism now that suspend
      // removes the deployment. Keeping it down while suspended would let this
      // fake certify behaviour production no longer has.
      state.services[service].running = true;
    }
    // `suspended` stays as it is: it is the STACK's flag, and `resume` owns
    // it. A redeploy of one service is not a decision about the whole stack.
  }

  async deployImage(
    refs: StackRefs,
    options: DeployImageOptions,
  ): Promise<void> {
    this.record("deployImage", [refs, options]);
    const state = this.mustGet(refs);
    const service = state.services[options.service];
    service.image = options.imageUrl;
    service.deployCount += 1;
    service.lastPreDeployCommand = options.preDeployCommand;
    // Same reasoning as `redeploy`: a deploy starts a container.
    service.running = true;
  }

  async attachDomain(
    refs: StackRefs,
    domain: string,
  ): Promise<DomainAttachment> {
    this.record("attachDomain", [refs, domain]);
    const state = this.mustGet(refs);

    const existing = state.domains.find((d) => d.domain === domain);
    if (existing) return { status: existing.status, records: existing.records };

    const entry: FakeDomainState = {
      domain,
      // Always pending: the substrate has not seen the tenant's DNS yet, and
      // claiming otherwise would let the dashboard lie.
      status: "pending",
      // TWO records, mirroring what a real substrate demands: a CNAME to route
      // the name and an ownership TXT to prove it. Railway 404s a custom domain
      // whose TXT is missing, permanently — so a fake that returned only the
      // CNAME would let a caller that publishes half the answer pass every test
      // in the control plane and fail in production.
      records: [
        {
          type: "CNAME",
          name: domain,
          value: `${state.spec.stackId}.fake-substrate.localhost`,
        },
        {
          type: "TXT",
          name: `_fake-verify.${domain}`,
          value: `fake-verify=${state.spec.stackId}`,
        },
      ],
    };
    state.domains.push(entry);
    return { status: entry.status, records: entry.records };
  }

  async getHealth(
    refs: StackRefs,
    options?: HealthOptions,
  ): Promise<HealthResult> {
    this.record("getHealth", [refs, options]);
    const state = this.mustGet(refs);

    if (state.suspended) {
      return { healthy: false, detail: "stack is suspended" };
    }
    if (state.unhealthy) {
      return { healthy: false, detail: "stack was marked unhealthy" };
    }
    const down = servicesFor(options?.service).filter(
      (service) => !state.services[service].running,
    );
    if (down.length > 0) {
      return { healthy: false, detail: `services not running: ${down.join()}` };
    }
    return { healthy: true };
  }

  async suspend(refs: StackRefs): Promise<void> {
    this.record("suspend", [refs]);
    const state = this.mustGet(refs);
    state.suspended = true;
    for (const service of SERVICES) state.services[service].running = false;
  }

  async resume(refs: StackRefs): Promise<void> {
    this.record("resume", [refs]);
    const state = this.mustGet(refs);
    state.suspended = false;
    for (const service of SERVICES) state.services[service].running = true;
  }

  /**
   * Log the call, then honour any scripted failure. The order matters: a test
   * asserting "the retry called `setEnv` twice" needs the FAILED attempt in the
   * log, not just the one that worked.
   */
  private record(method: FakeSubstrateMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const queue = this.scriptedFailures.get(method);
    const failure = queue?.shift();
    if (failure) throw failure;
  }

  /**
   * Resolve refs to state, or refuse. Unknown refs are a NOT-FOUND rather than
   * a crash, so the pipeline's "the stack is gone" branch is reachable in
   * tests exactly as it is in production.
   */
  private mustGet(refs: StackRefs): FakeStackState {
    const stackId = refs.data?.stackId;
    if (typeof stackId !== "string") {
      throw new SubstrateNotFoundError("Stack", String(stackId));
    }
    const state = this.stacks.get(stackId);
    if (!state) throw new SubstrateNotFoundError("Stack", stackId);
    return state;
  }
}

/**
 * Test-only view of stack state. Declared HERE rather than imported from
 * `contract.ts` on purpose: that module imports vitest, and nothing reachable
 * from `getSubstrate()` may drag a dev dependency into a production bundle. The
 * shape is structurally identical to `SubstrateStackSnapshot`, and the harness
 * in the test wires them together — so a drift between the two is a type error
 * at that seam, not a silent divergence.
 */
export interface FakeStackSnapshot {
  services: Record<SubstrateService, { image: string; running: boolean }>;
  env: Record<SubstrateService, Record<string, string>>;
}

function newService(spec: StackSpec): FakeServiceState {
  return {
    image: spec.initialImage,
    env: { ...spec.env },
    running: true,
    deployCount: 1,
  };
}

function servicesFor(service?: SubstrateService): SubstrateService[] {
  return service ? [service] : SERVICES;
}
