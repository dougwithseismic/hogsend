// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React, { type ReactNode } from "react";
import { Heading, Hr, Button as REButton, Section, Text } from "react-email";

// Shared, email-safe UI primitives: near-black CTAs, an accent color,
// monospace for anything technical, generous whitespace, hairline borders
// instead of heavy shadows. Compose these in templates instead of repeating
// Tailwind class soup. Edit freely — this is your design system.

type Tone = "default" | "brand" | "success" | "warn" | "danger";

const CALLOUT_TONES: Record<Tone, string> = {
  default: "border-zinc-200 bg-zinc-50",
  brand: "border-indigo-200 bg-indigo-50",
  success: "border-emerald-200 bg-emerald-50",
  warn: "border-amber-200 bg-amber-50",
  danger: "border-red-200 bg-red-50",
};

// Preserve leading indentation in HTML (which collapses runs of spaces) by
// swapping leading spaces for non-breaking spaces.
const NBSP = " ";
function indent(line: string): string {
  return line.replace(/^ +/, (m) => NBSP.repeat(m.length));
}

/** Small uppercase label that sits above the heading. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <Text className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-indigo-600">
      {children}
    </Text>
  );
}

/** Page heading — one per email. */
export function Title({ children }: { children: ReactNode }) {
  return (
    <Heading className="m-0 mb-4 text-[24px] font-bold leading-tight tracking-tight text-zinc-900">
      {children}
    </Heading>
  );
}

/** Body copy. */
export function Body({ children }: { children: ReactNode }) {
  return (
    <Text className="m-0 mb-4 text-[15px] leading-7 text-zinc-600">
      {children}
    </Text>
  );
}

/** Near-black primary CTA, or an outlined secondary. */
export function Button({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  const styles =
    variant === "secondary"
      ? "border border-solid border-zinc-300 bg-white text-zinc-900"
      : "bg-zinc-900 text-white";
  return (
    <REButton
      href={href}
      className={`box-border inline-block rounded-lg px-5 py-3 text-sm font-semibold no-underline ${styles}`}
    >
      {children}
    </REButton>
  );
}

/** Tinted, bordered panel for asides, warnings, and highlights. */
export function Callout({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <Section
      className={`my-5 rounded-xl border border-solid px-5 py-4 ${CALLOUT_TONES[tone]}`}
    >
      {children}
    </Section>
  );
}

/** Dark terminal-style code block. Pass a multi-line string. */
export function CodeBlock({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <Section className="my-5 overflow-hidden rounded-xl border border-solid border-zinc-800 bg-zinc-950 px-5 py-4">
      {lines.map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: code lines are static + ordered
          key={i}
          className={`m-0 font-mono text-[13px] leading-6 ${
            line.trimStart().startsWith("#") ? "text-zinc-500" : "text-zinc-100"
          }`}
        >
          {line === "" ? NBSP : indent(line)}
        </Text>
      ))}
    </Section>
  );
}

/** Arrow-marked list, great for "what to do next" or value bullets. */
export function Bullets({
  items,
  marker = "→",
}: {
  items: ReactNode[];
  marker?: string;
}) {
  return (
    <Section className="my-2">
      {items.map((item, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: list items are static + ordered
          key={i}
          className="m-0 mb-2 text-[15px] leading-6 text-zinc-700"
        >
          <span className="mr-2 font-semibold text-indigo-500">{marker}</span>
          {item}
        </Text>
      ))}
    </Section>
  );
}

/** Thin divider. */
export function Divider() {
  return <Hr className="my-7 border-zinc-200" />;
}
