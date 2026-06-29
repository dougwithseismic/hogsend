import type { JSX } from "react";
import { CodeHighlight } from "./code-highlight";
import { CopyButton } from "./copy-button";

type CodeWindowProps = {
  /** Shown in the window chrome, e.g. "src/journeys/abandoned-cart.ts". */
  filename: string;
  code: string;
  /** Highlight language; defaults to TypeScript. */
  lang?: string;
};

/**
 * Dark glass code panel over a red atmospheric bloom (crimzon treatment):
 * traffic-light dots, a mono filename, a copy button, and server-highlighted
 * code. Shared by the recipe cookbook and the use-case code walkthroughs so
 * every code sample on the marketing site copies the same way.
 */
export function CodeWindow({
  filename,
  code,
  lang = "ts",
}: CodeWindowProps): JSX.Element {
  return (
    <div className="relative">
      {/* Red atmospheric bloom behind the glass panel. */}
      <div
        aria-hidden="true"
        className="-inset-x-10 -inset-y-6 pointer-events-none absolute"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 65%, rgba(246, 72, 56, 0.14), transparent 70%)",
          filter: "blur(40px)",
        }}
      />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0a0606]">
        <div className="flex items-center justify-between gap-3 border-white/[0.08] border-b px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
            </div>
            <span className="font-mono text-[11px] text-white/40 tracking-wide">
              {filename}
            </span>
          </div>
          <CopyButton value={code} />
        </div>
        <div className="px-4 py-4">
          <CodeHighlight code={code} lang={lang} />
        </div>
      </div>
    </div>
  );
}
