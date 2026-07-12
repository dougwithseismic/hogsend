import type { VoiceToolCall, VoiceToolResult } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { voiceCalls, voiceToolCalls } from "@hogsend/db";
import type {
  VoiceTool,
  VoiceToolContext,
  VoiceToolRegistry,
} from "@hogsend/voice";
import { and, eq } from "drizzle-orm";
import type { Logger } from "./logger.js";
import { normalizePhone } from "./phone.js";

/** Default per-tool wall-clock budget. The provider blocks the call on the reply
 * (Vapi caps a tool at ~20s), so a slow handler must yield a graceful fallback
 * rather than hang the conversation. */
const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** Serialize a handler return into the string the LLM reads back. */
function toResultString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function errorResult(call: VoiceToolCall, message: string): VoiceToolResult {
  return {
    toolCallId: call.toolCallId,
    name: call.name,
    result: toResultString({ error: message }),
  };
}

interface CallRow {
  voiceCallId: string;
  userId: string | null;
  agentKey: string | null;
  toNumber: string;
  allowedTools: string[];
  variables?: Record<string, string | number | boolean>;
}

/**
 * Resolve the `voice_calls` row for a mid-call tool call, SCOPED to the provider
 * that sent the webhook (so a colliding provider-call-id across providers can't
 * cross-execute). Returns null when there is no matching row — the dispatcher
 * then REFUSES to run the tool (an unknown call must not trigger side effects).
 */
async function resolveCallRow(
  db: Database,
  providerId: string | undefined,
  call: VoiceToolCall,
): Promise<CallRow | null> {
  const where = providerId
    ? and(
        eq(voiceCalls.providerCallId, call.callId),
        eq(voiceCalls.providerId, providerId),
      )
    : eq(voiceCalls.providerCallId, call.callId);
  const rows = await db
    .select({
      voiceCallId: voiceCalls.id,
      userId: voiceCalls.userId,
      agentKey: voiceCalls.agentKey,
      toNumber: voiceCalls.toNumber,
      metadata: voiceCalls.metadata,
    })
    .from(voiceCalls)
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const meta = (row.metadata ?? {}) as {
    allowedTools?: unknown;
    variables?: unknown;
  };
  return {
    voiceCallId: row.voiceCallId,
    userId: row.userId,
    agentKey: row.agentKey,
    toNumber: row.toNumber,
    allowedTools: Array.isArray(meta.allowedTools)
      ? (meta.allowedTools.filter((t) => typeof t === "string") as string[])
      : [],
    variables:
      meta.variables && typeof meta.variables === "object"
        ? (meta.variables as Record<string, string | number | boolean>)
        : undefined,
  };
}

/** Check required params (from the tool's JSON schema) are present. */
function missingRequired(
  tool: VoiceTool,
  args: Record<string, unknown>,
): string[] {
  const required = (tool.spec.parameters as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (k) => typeof k === "string" && !(k in args),
  ) as string[];
}

function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`tool timed out after ${ms}ms`)),
      ms,
    );
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Execute a batch of mid-call tool calls and return one {@link VoiceToolResult}
 * per call (order-preserving). Every stage fails SOFT to an error result (never
 * throws) so a bad tool can't hang the live call. Guarantees, in order:
 *
 *  1. **Scoped call resolution** — the tool runs only for a `voice_calls` row
 *     that matches this provider + call id (no row ⇒ refused).
 *  2. **Authorization** — the tool name must be in the agent's declared tools
 *     for THIS call (persisted on the row), so a globally-registered tool can't
 *     be invoked by an agent that never declared it.
 *  3. **Idempotency** — a `voice_tool_calls` unique `tool_call_id` insert makes a
 *     retried webhook replay the STORED result instead of re-executing (no
 *     double-booking).
 *  4. **Validation** — required JSON-schema params must be present.
 *  5. **Timeout** — a slow handler yields a graceful fallback.
 */
export async function dispatchVoiceToolCalls(opts: {
  db?: Database;
  providerId?: string;
  calls: VoiceToolCall[];
  tools: VoiceToolRegistry;
  logger?: Logger;
  timeoutMs?: number;
}): Promise<VoiceToolResult[]> {
  const { db, providerId, calls, tools, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return Promise.all(
    calls.map(async (call): Promise<VoiceToolResult> => {
      const tool = Object.hasOwn(tools, call.name)
        ? tools[call.name]
        : undefined;
      if (!tool) {
        logger?.warn("voice tool call for an unregistered tool", {
          name: call.name,
          callId: call.callId,
        });
        return errorResult(call, `Unknown tool: ${call.name}`);
      }
      if (!db) return errorResult(call, "Voice tools require a database");

      // (1) + (2) scoped resolution + authorization.
      const row = await resolveCallRow(db, providerId, call).catch((err) => {
        logger?.warn("voice tool call-row lookup failed", {
          callId: call.callId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      if (!row) {
        return errorResult(call, "No active call for this tool invocation");
      }
      if (!row.allowedTools.includes(call.name)) {
        logger?.warn("voice tool not authorized for this agent", {
          name: call.name,
          agentKey: row.agentKey,
          callId: call.callId,
        });
        return errorResult(call, `Tool "${call.name}" is not allowed here`);
      }

      // (3) idempotency: claim the toolCallId. A conflict means a retry — replay
      // the stored result (or a benign "in progress" note if it hasn't landed).
      let claimed = false;
      try {
        const ins = await db
          .insert(voiceToolCalls)
          .values({
            voiceCallId: row.voiceCallId,
            toolCallId: call.toolCallId,
            name: call.name,
          })
          .onConflictDoNothing({ target: voiceToolCalls.toolCallId })
          .returning({ id: voiceToolCalls.id });
        claimed = ins.length > 0;
      } catch (err) {
        logger?.warn("voice tool idempotency claim failed", {
          callId: call.callId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!claimed) {
        const prior = await db
          .select({ result: voiceToolCalls.result })
          .from(voiceToolCalls)
          .where(eq(voiceToolCalls.toolCallId, call.toolCallId))
          .limit(1);
        return {
          toolCallId: call.toolCallId,
          name: call.name,
          result: prior[0]?.result ?? toResultString({ status: "in_progress" }),
        };
      }

      // (4) validation.
      const missing = missingRequired(tool, call.args);
      if (missing.length) {
        const res = errorResult(
          call,
          `Missing required parameter(s): ${missing.join(", ")}`,
        );
        await db
          .update(voiceToolCalls)
          .set({ result: res.result })
          .where(eq(voiceToolCalls.toolCallId, call.toolCallId));
        return res;
      }

      const ctx: VoiceToolContext = {
        callId: call.callId,
        phone: normalizePhone(row.toNumber) ?? row.toNumber,
        ...(row.agentKey ? { agentKey: row.agentKey } : {}),
        ...(row.userId ? { userId: row.userId } : {}),
        ...(row.variables ? { variables: row.variables } : {}),
      };

      try {
        // (5) timeout.
        const value = await withTimeout(
          tool.handler(call.args, ctx),
          timeoutMs,
        );
        const result = toResultString(value);
        await db
          .update(voiceToolCalls)
          .set({ result })
          .where(eq(voiceToolCalls.toolCallId, call.toolCallId));
        return { toolCallId: call.toolCallId, name: call.name, result };
      } catch (err) {
        logger?.warn("voice tool handler failed", {
          name: call.name,
          callId: call.callId,
          error: err instanceof Error ? err.message : String(err),
        });
        const res = errorResult(
          call,
          err instanceof Error ? err.message : "Tool execution failed",
        );
        // Release the claim so a genuine retry can re-attempt a FAILED tool
        // (unlike a succeeded one, which must stay deduped).
        await db
          .delete(voiceToolCalls)
          .where(eq(voiceToolCalls.toolCallId, call.toolCallId))
          .catch(() => {});
        return res;
      }
    }),
  );
}
