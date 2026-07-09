import { renderMermaidSVG } from "beautiful-mermaid";
import type { ReactNode } from "react";

/**
 * Renders Mermaid diagrams in the docs site — SERVER-SIDE, at build/request
 * time, via beautiful-mermaid (a synchronous, zero-DOM renderer). No client
 * mermaid bundle, no `unsafe-eval` CSP requirement, no hydration pass, no
 * loading flash: the page ships finished SVG.
 *
 * Theme: the dark "crimzon" palette (near-black canvas, single red accent) so
 * diagrams match the Hogsend brand.
 */

const THEME = {
  bg: "#050101",
  fg: "#ffffff",
  accent: "#f64838",
  line: "#9ca3af",
  muted: "#9ca3af",
  surface: "#0a0606",
  border: "#3f3f46",
  font: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
} as const;

interface MermaidProps {
  /** The raw Mermaid diagram source (without surrounding fences). */
  chart: string;
}

export function Mermaid({ chart }: MermaidProps) {
  let svg: string;
  try {
    svg = renderMermaidSVG(chart, THEME);
  } catch (err) {
    // A diagram the renderer can't parse still shows its source rather than
    // breaking the page build.
    return (
      <pre className="my-4 overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.015] p-4 text-sm text-white/70">
        {chart}
        {"\n\n"}
        {`(diagram render failed: ${err instanceof Error ? err.message : String(err)})`}
      </pre>
    );
  }

  return (
    <div
      className="my-4 flex justify-center overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.015] p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: beautiful-mermaid renders trusted SVG from our own generator, server-side
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * A `<pre>` override that detects ```mermaid fences and renders them via
 * `<Mermaid>`, leaving all other code blocks to Fumadocs' default `<pre>`.
 * Registered in `getMDXComponents`. Runs in RSC — no client boundary.
 */
export function MermaidPre({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  // Fumadocs passes the language class as `language-mermaid` on the <code>.
  const isMermaid =
    className?.includes("language-mermaid") ||
    (typeof children === "object" &&
      children !== null &&
      "props" in children &&
      typeof children.props === "object" &&
      children.props !== null &&
      "className" in children.props &&
      typeof children.props.className === "string" &&
      children.props.className.includes("language-mermaid"));

  if (isMermaid) {
    const text = extractText(children);
    return <Mermaid chart={text} />;
  }

  return <pre className={className}>{children}</pre>;
}

/** Recursively extract text content from a React node tree. */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (
    typeof node === "object" &&
    node !== null &&
    "props" in node &&
    typeof node.props === "object" &&
    node.props !== null &&
    "children" in node.props
  ) {
    return extractText(node.props.children as ReactNode);
  }
  return "";
}
