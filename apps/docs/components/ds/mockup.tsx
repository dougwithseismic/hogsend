import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
// Imported here (not re-exported via `export ... from`) so this stays a
// server module that merely forwards the client chat panel.
import { ChatDemo } from "./chat-demo";

export { ChatDemo };

type MockupFrameProps = {
  children: ReactNode;
  /** Legacy prop — the barcode motif is retired; accepted and ignored. */
  barcode?: boolean;
  className?: string;
};

/**
 * Dark glass mockup panel hosting product UI: 12px radius, white/10 hairline,
 * near-black #0a0606 glass fill.
 */
export function MockupFrame({
  children,
  barcode: _barcode,
  className,
}: MockupFrameProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-white/10 bg-[#0a0606]/80 backdrop-blur-sm",
        className,
      )}
    >
      <div className="p-5 md:p-6">{children}</div>
    </div>
  );
}

type CodeTone = "comment" | "keyword" | "string" | "plain" | "accent";

type CodeLine = {
  text: string;
  tone?: CodeTone;
};

type CodeMockProps = {
  lines: Array<CodeLine>;
  filename?: string;
  className?: string;
};

const CODE_TONE_CLASS: Record<CodeTone, string> = {
  comment: "text-white/40",
  keyword: "text-accent",
  string: "text-white/80",
  accent: "text-accent",
  plain: "text-white/80",
};

/**
 * Faux code block in a dark glass frame (10px radius, white/10 hairline,
 * #0a0606 fill) with optional window chrome (three dots + filename).
 * Each line is colored by its `tone` (defaults to plain).
 */
export function CodeMock({ lines, filename, className }: CodeMockProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border border-white/10 bg-[#0a0606]",
        className,
      )}
    >
      {filename ? (
        <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            {filename}
          </span>
        </div>
      ) : null}

      <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed">
        <code className="block">
          {lines.map((line, index) => (
            <span
              // Code lines are a fixed, ordered list that never reorders, so the
              // index is a stable key (line text may repeat, e.g. blank lines).
              // biome-ignore lint/suspicious/noArrayIndexKey: stable, never reordered
              key={index}
              className={cn(
                "block whitespace-pre",
                CODE_TONE_CLASS[line.tone ?? "plain"],
              )}
            >
              {line.text === "" ? " " : line.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

type IntegrationItem = {
  label: string;
  icon?: ReactNode;
};

type IntegrationGridProps = {
  items: Array<IntegrationItem>;
  className?: string;
};

/**
 * Grid of small integration chips — optional leading icon + label
 * (e.g. PostHog, Resend, Slack, GitHub, Stripe, Discord, Webhook).
 */
export function IntegrationGrid({ items, className }: IntegrationGridProps) {
  return (
    <ul className={cn("grid grid-cols-2 gap-2.5 sm:grid-cols-3", className)}>
      {items.map((item) => (
        <li
          key={item.label}
          className="flex items-center gap-2.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 transition-colors duration-200 hover:border-white/15"
        >
          {item.icon ? (
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center text-white/70 [&>svg]:size-4"
            >
              {item.icon}
            </span>
          ) : null}
          <span className="truncate text-sm text-white/80 tracking-[-0.02em]">
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
