/**
 * The transport-agnostic tool record shape — the same `{ name, description,
 * inputSchema, handler }` contract `packages/engine/src/mcp/blueprint-tools.ts`
 * uses, adapted for the MCP SDK's `registerTool(name, { description,
 * inputSchema }, cb)` API where `inputSchema` is a Zod RAW SHAPE (a plain
 * `{ key: ZodType }` object), NOT a `ZodObject`.
 *
 * `server.ts` wraps each record's `handler` into an SDK tool callback; unit
 * tests call `handler` directly. The handler safe-parses its own input (so it
 * is self-contained even when a host doesn't pre-validate) and returns the
 * discriminated `ok` result — it never throws for an expected failure.
 */
import { z } from "zod";
import { invalidInput } from "./result.js";

export type ToolRawShape = z.ZodRawShape;

export interface McpTool<Shape extends ToolRawShape = ToolRawShape> {
  name: string;
  description: string;
  /** A Zod raw shape — pass straight to `server.registerTool`'s `inputSchema`. */
  inputSchema: Shape;
  /** Expected failures come back as `{ ok: false, ... }`; never thrown. */
  handler: (input: unknown) => Promise<unknown>;
}

/**
 * Build a tool record from a raw shape and a typed `run`. Does the
 * parse-or-`invalid_input` ritual once (mirrors the engine's `blueprint-tools`
 * `defineTool`), so each tool only writes its business logic against already-
 * parsed, typed input. The returned record keeps the CONCRETE `inputSchema`, so
 * `server.ts` still registers inline and the SDK's `ShapeOutput` inference is
 * untouched.
 */
export function defineTool<Shape extends ToolRawShape>(def: {
  name: string;
  description: string;
  inputSchema: Shape;
  run: (data: z.output<z.ZodObject<Shape>>) => Promise<unknown>;
}): McpTool<Shape> {
  const schema = z.object(def.inputSchema);
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: async (input) => {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) return invalidInput(def.name, parsed.error);
      return def.run(parsed.data);
    },
  };
}
