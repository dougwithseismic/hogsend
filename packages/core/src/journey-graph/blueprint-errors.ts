// ---------------------------------------------------------------------------
// Typed runtime errors for blueprint EXECUTION (spec §6.1). Validation-time
// problems are structured `BlueprintValidationIssue[]`s (blueprint.ts); these
// classes are what the interpreter throws when a node fails AT RUN TIME, so
// the failure carries enough structure (blueprintId + nodeId) for
// `journeyStates.errorMessage`, Studio, and the admin API to point at exactly
// what broke — never a bare string. Shared between the engine's interpreter
// task and (later) the admin routes' error responses, hence they live here in
// core next to the blueprint schema.
// ---------------------------------------------------------------------------

/**
 * A specific blueprint node failed to execute — a provider send threw, a
 * decision's conditions could not be evaluated, required meta was missing at
 * run time (jsonb defense-in-depth), or the walk reached a node type outside
 * the executable vocabulary (which means `validateBlueprintGraph` was
 * bypassed). `cause` preserves the underlying error/detail verbatim.
 */
export class BlueprintNodeExecutionError extends Error {
  constructor(
    public readonly blueprintId: string,
    public readonly nodeId: string,
    public readonly cause: unknown,
  ) {
    const detail =
      typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(`blueprint "${blueprintId}" failed at node "${nodeId}": ${detail}`);
    this.name = "BlueprintNodeExecutionError";
  }
}

/**
 * The tree-walk was directed at a node id that does not exist in the graph —
 * an edge whose `target` names a missing node. Structurally impossible in a
 * graph that passed `validateBlueprintGraph` (`findInvalidEdgeEndpoints`
 * rejects it at save time); thrown as defense-in-depth when executing a graph
 * that bypassed validation.
 */
export class BlueprintUnreachableNodeError extends Error {
  constructor(
    public readonly blueprintId: string,
    public readonly nodeId: string,
  ) {
    super(
      `blueprint "${blueprintId}": the walk was directed at node "${nodeId}", which does not exist in the graph`,
    );
    this.name = "BlueprintUnreachableNodeError";
  }
}

/**
 * Extract the `{ blueprintId, nodeId, message }` shape the engine writes into
 * `journeyStates.errorMessage` (as JSON) for a failed blueprint run. `nodeId`
 * is null when the failure did not originate at a specific node (e.g. an
 * infrastructure error thrown outside the walk).
 */
export function serializeBlueprintError(
  blueprintId: string,
  err: unknown,
): { blueprintId: string; nodeId: string | null; message: string } {
  const nodeId =
    err instanceof BlueprintNodeExecutionError ||
    err instanceof BlueprintUnreachableNodeError
      ? err.nodeId
      : null;
  const message =
    err instanceof Error ? err.message : String(err ?? "unknown error");
  return { blueprintId, nodeId, message };
}
