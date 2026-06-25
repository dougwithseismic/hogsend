import type { UIMessage } from "ai";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Loose view over an AI-SDK tool part (tool-<name> or dynamic-tool). */
type ToolPartView = {
  toolName: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function asToolPart(part: { type: string }): ToolPartView | null {
  const p = part as Record<string, unknown> & { type: string };
  if (p.type === "dynamic-tool") {
    return {
      toolName: typeof p.toolName === "string" ? p.toolName : "tool",
      state: typeof p.state === "string" ? p.state : undefined,
      input: p.input,
      output: p.output,
      errorText: typeof p.errorText === "string" ? p.errorText : undefined,
    };
  }
  if (p.type.startsWith("tool-")) {
    return {
      toolName: p.type.slice(5),
      state: typeof p.state === "string" ? p.state : undefined,
      input: p.input,
      output: p.output,
      errorText: typeof p.errorText === "string" ? p.errorText : undefined,
    };
  }
  return null;
}

function summarize(output: unknown): string {
  if (Array.isArray(output)) {
    return `${output.length} result${output.length === 1 ? "" : "s"}`;
  }
  if (output && typeof output === "object") {
    return Object.keys(output as object)
      .slice(0, 3)
      .join(", ");
  }
  return "done";
}

function ToolCard({ part }: { part: ToolPartView }) {
  const [expanded, setExpanded] = useState(false);
  const running =
    part.state !== "output-available" && part.state !== "output-error";
  const errored = part.state === "output-error";

  return (
    <div className="rounded-md border border-hairline-faint bg-white/[0.03]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/50" />
        ) : (
          <Wrench
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              errored ? "text-accent" : "text-white/50",
            )}
          />
        )}
        <span className="font-mono text-white/80 text-xs">{part.toolName}</span>
        <span className="truncate text-white/40 text-xs">
          {running
            ? "running…"
            : errored
              ? (part.errorText ?? "error")
              : `→ ${summarize(part.output)}`}
        </span>
        <span className="ml-auto shrink-0 text-white/30">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-hairline-faint border-t px-3 py-2">
          {part.input !== undefined ? (
            <div>
              <p className="mb-1 text-[10px] text-white/40 uppercase tracking-wide">
                input
              </p>
              <pre className="max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] text-white/70">
                {JSON.stringify(part.input, null, 2)}
              </pre>
            </div>
          ) : null}
          {part.output !== undefined ? (
            <div>
              <p className="mb-1 text-[10px] text-white/40 uppercase tracking-wide">
                output
              </p>
              <pre className="max-h-56 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] text-white/70">
                {JSON.stringify(part.output, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Render one chat message: its text parts as prose, its tool parts as cards. */
export function MessageParts({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        isUser ? "items-end" : "items-start",
      )}
    >
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only and stable within a message
              key={i}
              className={cn(
                "max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed",
                isUser
                  ? "bg-accent-tint text-white"
                  : "bg-white/[0.04] text-white/90",
              )}
            >
              {part.text}
            </div>
          );
        }
        const tool = asToolPart(part);
        if (tool) {
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only and stable within a message
              key={i}
              className="w-[90%]"
            >
              <ToolCard part={tool} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
