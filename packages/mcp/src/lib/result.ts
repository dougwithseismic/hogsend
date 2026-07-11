/**
 * The discriminated result contract every tool returns — ported from
 * `packages/engine/src/mcp/blueprint-tools.ts`. Handlers NEVER throw for an
 * EXPECTED failure: every outcome is an object discriminated on `ok`, with a
 * `code` on failures, so an agent iterates on a structured "what happened"
 * value instead of a caught exception's `.message`. Only genuinely unexpected
 * errors (a real bug) propagate as a throw, which the MCP host surfaces.
 *
 * {@link mapHttpError} translates the admin API's HTTP statuses into that
 * shape: the transport failure (`status: 0`) and each documented status the
 * admin routes emit map to a stable `code`, and the graph-validation `422`
 * carries the same structured `issues[]` the routes return verbatim.
 */
import type { z } from "zod";
import {
  arrayField,
  type HttpError,
  isHttpError,
  stringField,
} from "./admin-client.js";

/** One structural/validation issue, mirroring `BlueprintValidationIssue`. */
export interface ToolIssue {
  nodeId?: string;
  edgeId?: string;
  path?: (string | number)[];
  code: string;
  message: string;
}

/** Returned when a tool's own arguments don't parse against its schema. */
export interface InvalidInputFailure {
  ok: false;
  code: "invalid_input";
  error: string;
  issues: ToolIssue[];
}

/** Every expected failure code the tools surface. */
export interface HttpFailure {
  ok: false;
  code:
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "in_flight"
    | "promoted"
    | "invalid_graph"
    | "unreachable"
    | "error";
  error: string;
  /** HTTP status (0 for a transport failure), for callers that want it. */
  status: number;
  /** Present on `invalid_graph` (a 422): the structured issue list, verbatim. */
  issues?: ToolIssue[];
}

export type ToolFailure = InvalidInputFailure | HttpFailure;

/** Build an `invalid_input` failure from a Zod parse error. */
export function invalidInput(
  toolName: string,
  error: z.ZodError,
): InvalidInputFailure {
  return {
    ok: false,
    code: "invalid_input",
    error: `Invalid input for ${toolName}`,
    issues: error.issues.map((issue) => ({
      path: issue.path.filter(
        (p): p is string | number => typeof p !== "symbol",
      ),
      code: issue.code,
      message: issue.message,
    })),
  };
}

/** A hand-authored `invalid_input` for a per-action requirement failure. */
export function requirement(
  toolName: string,
  message: string,
): InvalidInputFailure {
  return {
    ok: false,
    code: "invalid_input",
    error: `Invalid input for ${toolName}: ${message}`,
    issues: [{ code: "requirement", message }],
  };
}

/**
 * Map an admin-API {@link HttpError} to a structured {@link HttpFailure}. A
 * non-HttpError (a genuine bug, never an expected outcome) is re-thrown — the
 * host's problem, per the contract.
 *
 * Status → code:
 *  - `0`   → `unreachable` (DNS/connect failure or missing admin key)
 *  - `401` → `unauthorized`, `403` → `forbidden` (with a full-admin-scope hint),
 *            `404` → `not_found`
 *  - `409` → the body's `code` (the engine's blueprint routes include it:
 *            `in_flight` / `promoted` / `conflict`), else `conflict`
 *  - `422` → `invalid_graph` with the route's structured `issues[]` verbatim
 *  - anything else → `error`
 */
export function mapHttpError(err: unknown): HttpFailure {
  if (!isHttpError(err)) throw err;
  const e: HttpError = err;
  const status = e.status;
  const error = stringField(e.body, "error") ?? e.message;

  if (status === 0) return { ok: false, code: "unreachable", error, status };
  if (status === 401) return { ok: false, code: "unauthorized", error, status };
  if (status === 403)
    return {
      ok: false,
      code: "forbidden",
      // requireAdmin gates every bearer admin call on the full-admin scope, so a
      // 403 almost always means a lesser-scoped key — say so.
      error: `${error} — the Hogsend admin API requires a full-admin-scoped key`,
      status,
    };
  if (status === 404) return { ok: false, code: "not_found", error, status };
  if (status === 422)
    return {
      ok: false,
      code: "invalid_graph",
      error,
      status,
      issues: (arrayField(e.body, "issues") as ToolIssue[] | undefined) ?? [],
    };
  if (status === 409) {
    const code =
      (stringField(e.body, "code") as HttpFailure["code"] | undefined) ??
      "conflict";
    return { ok: false, code, error, status };
  }
  return { ok: false, code: "error", error, status };
}
