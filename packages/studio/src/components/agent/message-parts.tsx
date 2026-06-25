import type { UIMessage } from "ai";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  Undo2,
  Wrench,
  X as XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ markdown */

// Explicit param props — react-markdown's `Components` contextual typing
// doesn't reliably flow to destructured params across TS/types-resolution
// environments (CI hit implicit-any), so annotate each component directly.
type MdProps = { children?: ReactNode };

// Memoized once at module scope so streaming re-renders don't realloc the map.
const MD_COMPONENTS: Components = {
  p: ({ children }: MdProps) => (
    <p className="mb-2 leading-relaxed last:mb-0">{children}</p>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline underline-offset-2 hover:text-accent/80"
    >
      {children}
    </a>
  ),
  strong: ({ children }: MdProps) => (
    <strong className="font-semibold text-white">{children}</strong>
  ),
  em: ({ children }: MdProps) => <em className="italic">{children}</em>,
  h1: ({ children }: MdProps) => (
    <h1 className="mt-3 mb-1.5 font-display text-base text-white">
      {children}
    </h1>
  ),
  h2: ({ children }: MdProps) => (
    <h2 className="mt-3 mb-1.5 font-display text-sm text-white">{children}</h2>
  ),
  h3: ({ children }: MdProps) => (
    <h3 className="mt-2 mb-1 font-display text-sm text-white/90">{children}</h3>
  ),
  ul: ({ children }: MdProps) => (
    <ul className="mb-2 list-disc space-y-1 pl-4 marker:text-white/30">
      {children}
    </ul>
  ),
  ol: ({ children }: MdProps) => (
    <ol className="mb-2 list-decimal space-y-1 pl-4 marker:text-white/30">
      {children}
    </ol>
  ),
  li: ({ children }: MdProps) => (
    <li className="leading-relaxed">{children}</li>
  ),
  hr: () => <hr className="my-3 border-hairline-faint" />,
  blockquote: ({ children }: MdProps) => (
    <blockquote className="my-2 border-hairline border-l-2 pl-3 text-white/60 italic">
      {children}
    </blockquote>
  ),
  code: ({
    className,
    children,
  }: {
    className?: string;
    children?: ReactNode;
  }) => {
    const isBlock =
      (className ?? "").includes("language-") ||
      String(children).includes("\n");
    if (isBlock) {
      return (
        <code className="block font-mono text-[12px] text-white/85 leading-relaxed">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[12px] text-white/90">
        {children}
      </code>
    );
  },
  pre: ({ children }: MdProps) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-black/30 p-3">
      {children}
    </pre>
  ),
  table: ({ children }: MdProps) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: MdProps) => (
    <thead className="border-hairline border-b">{children}</thead>
  ),
  th: ({ children }: MdProps) => (
    <th className="border border-hairline-faint px-2 py-1 text-left font-medium text-white/80">
      {children}
    </th>
  ),
  td: ({ children }: MdProps) => (
    <td className="border border-hairline-faint px-2 py-1 align-top text-white/70">
      {children}
    </td>
  ),
};

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="text-sm text-white/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/* --------------------------------------------------------------- tool cards */

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

/* ------------------------------------------------------ HITL confirmation */

type ProposalTier = "write_safe" | "write_external" | "destructive";

type ConfirmationProposal = {
  status: "needs_confirmation";
  proposalId: string;
  token: string;
  summary: string;
  tier: ProposalTier;
  confirmPhrase?: string;
};

function isConfirmationProposal(o: unknown): o is ConfirmationProposal {
  return (
    !!o &&
    typeof o === "object" &&
    (o as { status?: unknown }).status === "needs_confirmation" &&
    typeof (o as { token?: unknown }).token === "string"
  );
}

const TIER_BADGE: Record<
  ProposalTier,
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  write_safe: { label: "Write", variant: "secondary" },
  write_external: { label: "External", variant: "default" },
  destructive: { label: "Destructive", variant: "destructive" },
};

function ToolConfirmationCard({
  proposal,
}: {
  proposal: ConfirmationProposal;
}) {
  const [phase, setPhase] = useState<
    "idle" | "running" | "done" | "error" | "cancelled"
  >("idle");
  const [result, setResult] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");

  const strong =
    proposal.tier === "write_external" || proposal.tier === "destructive";
  const requiresType = proposal.tier === "destructive";
  const phrase = proposal.confirmPhrase ?? "RUN";
  const badge = TIER_BADGE[proposal.tier] ?? TIER_BADGE.destructive;

  const gated = (strong && !ack) || (requiresType && typed.trim() !== phrase);
  const terminal =
    phase === "done" || phase === "error" || phase === "cancelled";

  const run = async () => {
    if (gated || phase === "running") return;
    setPhase("running");
    try {
      const res = await api.post<{
        ok?: boolean;
        result?: unknown;
        error?: string;
      }>("/v1/admin/agent/confirm", { json: { token: proposal.token } });
      setResult(res?.ok === false ? (res.error ?? "Failed.") : "Done.");
      setPhase(res?.ok === false ? "error" : "done");
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Confirmation failed.");
      setPhase("error");
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border bg-accent-tint",
        phase === "error" ? "border-accent" : "border-accent/40",
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant={badge.variant} className="shrink-0">
              {badge.label}
            </Badge>
            <span className="font-display text-white text-xs">
              Confirm action
            </span>
          </div>
          <p className="text-sm text-white/85">{proposal.summary}</p>

          {strong && !terminal ? (
            <label className="flex items-center gap-2 text-white/70 text-xs">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-accent,#f64838)]"
              />
              I understand this is{" "}
              {proposal.tier === "destructive"
                ? "irreversible"
                : "an external write"}
              .
            </label>
          ) : null}

          {requiresType && !terminal ? (
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Type "${phrase}" to confirm`}
              className="w-full rounded border border-hairline-faint bg-black/20 px-2 py-1 font-mono text-white text-xs placeholder:text-white/30 focus:border-hairline focus:outline-none"
            />
          ) : null}

          {terminal ? (
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs",
                phase === "error" ? "text-accent" : "text-white/60",
              )}
            >
              {phase === "done" ? <Check className="h-3.5 w-3.5" /> : null}
              {phase === "cancelled" ? "Cancelled." : result}
            </p>
          ) : (
            <div className="flex items-center gap-2 pt-0.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPhase("cancelled")}
                disabled={phase === "running"}
              >
                <XIcon className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button
                variant={strong ? "destructive" : "default"}
                size="sm"
                onClick={run}
                disabled={gated || phase === "running"}
              >
                {phase === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Run
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- message */

export type MessageActions = {
  onEdit?: (id: string, currentText: string) => void;
  onRegenerate?: (id: string) => void;
  onRollback?: (id: string) => void;
  busy?: boolean;
};

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function MessageParts({
  message,
  actions,
}: {
  message: UIMessage;
  actions?: MessageActions;
}) {
  const isUser = message.role === "user";
  const busy = actions?.busy;

  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5",
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
                "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed",
                isUser
                  ? "whitespace-pre-wrap bg-accent-tint text-white"
                  : "bg-white/[0.04]",
              )}
            >
              {isUser ? part.text : <MarkdownText text={part.text} />}
            </div>
          );
        }

        const tool = asToolPart(part);
        if (tool) {
          if (isConfirmationProposal(tool.output)) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable within message
              <div key={i} className="w-[90%]">
                <ToolConfirmationCard proposal={tool.output} />
              </div>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable within message
            <div key={i} className="w-[90%]">
              <ToolCard part={tool} />
            </div>
          );
        }
        return null;
      })}

      {actions ? (
        <div
          className={cn(
            "flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
            isUser ? "flex-row-reverse" : "flex-row",
          )}
        >
          {isUser ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => actions.onEdit?.(message.id, messageText(message))}
              aria-label="Edit message"
              className="rounded p-1 text-white/30 hover:text-white/70 disabled:opacity-30"
            >
              <Pencil className="h-3 w-3" />
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => actions.onRegenerate?.(message.id)}
                aria-label="Regenerate"
                className="rounded p-1 text-white/30 hover:text-white/70 disabled:opacity-30"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard?.writeText(messageText(message))
                }
                aria-label="Copy"
                className="rounded p-1 text-white/30 hover:text-white/70"
              >
                <Copy className="h-3 w-3" />
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.onRollback?.(message.id)}
            aria-label="Rollback to here"
            className="rounded p-1 text-white/30 hover:text-white/70 disabled:opacity-30"
          >
            <Undo2 className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
