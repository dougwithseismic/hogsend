import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
// Imported here (not re-exported via `export ... from`) so this stays a
// server module that merely forwards the client chat panel.
import { ChatDemo } from "./chat-demo";

export { ChatDemo };

type MockupFrameProps = {
  children: ReactNode;
  /**
   * Legacy prop kept for call-site compatibility. The old green barcode/comb
   * "registration" strip has been retired in the cream redesign, so this is now
   * a visual no-op — the frame renders identically with or without it.
   */
  barcode?: boolean;
  className?: string;
};

/**
 * Dark inset mockup panel used to host faux product UI / screenshots. In the
 * cream redesign these stay DARK (`bg-ink`) rounded insets sitting on the cream
 * page — matching Wispr Flow's dark inset cards. The `barcode` prop is retained
 * for compatibility but no longer renders anything.
 */
export function MockupFrame({ children, className }: MockupFrameProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-ink/10 bg-ink",
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

/**
 * Code tone palette retuned for the dark (`bg-ink`) inset card: comments fade
 * the cream text, keywords/accents glow amber, strings/plain text read in soft
 * cream. No green anywhere.
 */
const CODE_TONE_CLASS: Record<CodeTone, string> = {
  comment: "text-lumen/40",
  keyword: "text-glow",
  string: "text-lumen/80",
  accent: "text-glow",
  plain: "text-lumen/80",
};

/**
 * Faux code block with optional window chrome (three dots + filename).
 * Each line is colored by its `tone` (defaults to plain). Renders as a dark
 * inset card so it reads as code regardless of the surrounding cream section.
 */
export function CodeMock({ lines, filename, className }: CodeMockProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-ink/10 bg-ink",
        className,
      )}
    >
      {filename ? (
        <div className="flex items-center gap-3 border-lumen/10 border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-lumen/15" />
            <span className="size-2.5 rounded-full bg-lumen/15" />
            <span className="size-2.5 rounded-full bg-lumen/15" />
          </div>
          <span className="font-mono text-[11px] text-lumen/40 tracking-wide">
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
 * (e.g. PostHog, Resend, Slack, GitHub, Stripe, Discord, Webhook). Rendered on
 * the dark inset surface: amber icon accents, soft cream labels.
 */
export function IntegrationGrid({ items, className }: IntegrationGridProps) {
  return (
    <ul className={cn("grid grid-cols-2 gap-2.5 sm:grid-cols-3", className)}>
      {items.map((item) => (
        <li
          key={item.label}
          className="flex items-center gap-2.5 rounded-lg border border-lumen/10 bg-lumen/[0.04] px-3 py-2.5"
        >
          {item.icon ? (
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center text-glow [&>svg]:size-4"
            >
              {item.icon}
            </span>
          ) : null}
          <span className="truncate font-mono text-[12px] text-lumen/80 tracking-wide">
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
