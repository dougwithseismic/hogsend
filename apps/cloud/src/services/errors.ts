/**
 * Typed failures shared by the control-plane services.
 *
 * Every one of these is a RULE the caller can act on — "you are out of
 * environments", "that region has no capacity" — not an accident. They all
 * extend one base so an API layer can map `CloudServiceError` to a 4xx with the
 * `code` verbatim, and let anything else escape as a 500.
 *
 * `code` is a stable machine-readable slug: the wire contract. `message` is for
 * humans and may be reworded freely.
 */
export abstract class CloudServiceError extends Error {
  /** Stable slug for API/CLI branching. Never reworded. */
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A referenced row does not exist, or is not visible to this organization. */
export class NotFoundError extends CloudServiceError {
  readonly code = "not_found";

  constructor(
    readonly resource: string,
    readonly id: string,
  ) {
    super(`${resource} "${id}" was not found`);
  }
}

/** The org's plan does not allow another environment. */
export class PlanLimitError extends CloudServiceError {
  readonly code = "plan_limit";

  constructor(
    readonly plan: string,
    readonly limit: number,
    readonly current: number,
  ) {
    super(
      `Plan "${plan}" allows ${limit} environment(s); this organization already has ${current}`,
    );
  }
}

/**
 * A shared-tier tenant asked for a region with no accepting cell that still has
 * capacity. Deliberately does NOT distinguish "no cell" from "cell full" in the
 * code — both have the same remedy for the tenant (choose another region or go
 * dedicated) and the difference is an ops fact, carried in `message` only.
 */
export class IllegalRegionError extends CloudServiceError {
  readonly code = "illegal_region";

  constructor(
    readonly region: string,
    readonly plan: string,
  ) {
    super(
      `No accepting cell with capacity in region "${region}" for plan "${plan}"`,
    );
  }
}

/** An organization may hold exactly one live `production` environment. */
export class DuplicateProductionError extends CloudServiceError {
  readonly code = "duplicate_production";

  constructor(readonly organizationId: string) {
    super(
      `Organization "${organizationId}" already has a production environment`,
    );
  }
}

/** The `(organization_id, name)` unique index, surfaced as a rule. */
export class DuplicateNameError extends CloudServiceError {
  readonly code = "duplicate_name";

  constructor(
    readonly organizationId: string,
    readonly name: string,
  ) {
    super(
      `Organization "${organizationId}" already has an environment named "${name}"`,
    );
  }
}

/** Production is the tenant root runtime; it goes only with the whole org. */
export class ProductionRemovalError extends CloudServiceError {
  readonly code = "production_removal";

  constructor(readonly environmentId: string) {
    super(
      `Environment "${environmentId}" is the production environment and cannot be removed`,
    );
  }
}

/**
 * The environment still has a provisioned (or provisioning) stack. Removing the
 * row here would orphan real infrastructure, so the caller must run the
 * suspend → destroy flow (PRD 04) first.
 */
export class StackNotRemovableError extends CloudServiceError {
  readonly code = "stack_not_removable";

  constructor(
    readonly environmentId: string,
    readonly status: string,
  ) {
    super(
      `Environment "${environmentId}" has a stack in "${status}"; suspend and destroy it before removing the environment`,
    );
  }
}

/**
 * The stack lifecycle refused an edge — either the pair is not in the
 * transition table at all, or the row had moved on before the write landed
 * (a lost race, which is the SAME failure to the caller: the state you assumed
 * is not the state that is).
 *
 * `from` is the status ACTUALLY observed on the row, not the one the caller
 * hoped for, so an operator reading the message learns where the stack really
 * is.
 */
export class IllegalTransitionError extends CloudServiceError {
  readonly code = "illegal_transition";

  constructor(
    readonly stackId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Stack "${stackId}" cannot move from "${from}" to "${to}"`);
  }
}

/**
 * The build state machine refused an edge, or lost the race for one. The exact
 * twin of `IllegalTransitionError` for builds, kept separate so an API layer
 * can say which machine refused without parsing a message.
 */
export class IllegalBuildTransitionError extends CloudServiceError {
  readonly code = "illegal_build_transition";

  constructor(
    readonly buildId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Build "${buildId}" cannot move from "${from}" to "${to}"`);
  }
}

/**
 * A build could not be STARTED because the environment already has one running
 * (PRD 08: "never two builds racing one stack").
 *
 * Raised from the partial unique index, not from a prior read — see
 * `builds_environment_running_unique_idx`. It is never an answer to a publish:
 * a publish queues. It is the answer to a WORKER that lost the race to claim
 * the environment, and its build simply stays `queued` for the next drain.
 */
export class BuildInFlightError extends CloudServiceError {
  readonly code = "build_in_flight";

  constructor(readonly environmentId: string) {
    super(
      `Environment "${environmentId}" already has a build running; it finishes before another can start`,
    );
  }
}

/**
 * The environment's publish QUEUE is full — the one refusal a publish can still
 * get once a build is already running.
 *
 * Backpressure, not a state machine rule: every queued build holds a tarball of
 * tenant source on a shared build host, so the depth is bounded. The caller
 * republishes; the queue drains at one build at a time.
 */
export class BuildQueueFullError extends CloudServiceError {
  readonly code = "build_queue_full";

  constructor(
    readonly environmentId: string,
    readonly limit: number,
  ) {
    super(
      `Environment "${environmentId}" already has ${limit} publishes waiting to build; publish again once the queue drains`,
    );
  }
}

/** Postgres unique-violation SQLSTATE, walked out of drizzle's wrapper. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver errors, so the postgres-js error (which carries `code`)
 * can sit one or more `cause` links down. Walk the chain rather than trusting
 * the top-level shape.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
