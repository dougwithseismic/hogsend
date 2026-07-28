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
