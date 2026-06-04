import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
// Imported here (not re-exported via `export ... from`) so this stays a
// server module that merely forwards the client chat panel.
import { ChatDemo } from "./chat-demo";
import { BarcodeStrip } from "./decor";

export { ChatDemo };

type MockupFrameProps = {
  children: ReactNode;
  barcode?: boolean;
  className?: string;
};

/**
 * Dark rounded mockup panel used to host faux product UI. When `barcode` is
 * set, a green comb/barcode strip runs along the top and bottom edges.
 */
export function MockupFrame({
  children,
  barcode,
  className,
}: MockupFrameProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[10px] border border-white/10 bg-black/80",
        className,
      )}
    >
      {barcode ? (
        <BarcodeStrip className="border-white/[0.08] border-b px-5 py-3" />
      ) : null}

      <div className="p-5 md:p-6">{children}</div>

      {barcode ? (
        <BarcodeStrip className="border-white/[0.08] border-t px-5 py-3" />
      ) : null}
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
 * Faux code block with optional window chrome (three dots + filename).
 * Each line is colored by its `tone` (defaults to plain).
 */
export function CodeMock({ lines, filename, className }: CodeMockProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border border-white/[0.08] bg-black/60",
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
              {line.text === "" ? " " : line.text}
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
          className="flex items-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
        >
          {item.icon ? (
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center text-accent [&>svg]:size-4"
            >
              {item.icon}
            </span>
          ) : null}
          <span className="truncate font-mono text-[12px] text-white/80 tracking-wide">
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
