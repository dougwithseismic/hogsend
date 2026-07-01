"use client";

/**
 * Minimal, inline-styled presentational primitives shared by every product
 * devtools panel. Deliberately dependency-free: no Tailwind classes, no design
 * system, no `cn()` — a panel is a self-contained leaf that renders through a
 * `createPortal` into the TanStack Devtools shell, so it must not lean on the
 * app's global CSS cascade to look right. Keeping these here also means a panel
 * stays a lightweight, copy-paste-able unit you can lift into another app.
 */

import type { CSSProperties, ReactNode } from "react";

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** A titled group of rows with a hairline header. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** Optional right-aligned control (a button, a count, …). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBottom: 14 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 0",
          marginBottom: 6,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.5)",
        }}
      >
        <span>{title}</span>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A label / value pair. `mono` monospaces the value (ids, keys, urls). */
export function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        justifyContent: "space-between",
        padding: "3px 0",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: "rgba(255,255,255,0.55)", flexShrink: 0 }}>
        {label}
      </span>
      <span
        style={{
          color: "rgba(255,255,255,0.92)",
          textAlign: "right",
          wordBreak: "break-all",
          fontFamily: mono ? MONO : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** A small status pill — green when `ok`, muted red otherwise. */
export function Pill({ ok, children }: { ok: boolean; children: ReactNode }) {
  const color = ok ? "#34d399" : "#f87171";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: MONO,
        fontSize: 11,
        color,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${color}`,
        }}
      />
      {children}
    </span>
  );
}

/** A compact action button styled for the dark devtools shell. */
export function Button({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    appearance: "none",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.04)",
    color: "rgba(255,255,255,0.9)",
    borderRadius: 6,
    padding: "3px 8px",
    fontSize: 11,
    fontFamily: MONO,
    cursor: "pointer",
  };
  return (
    <button type="button" onClick={onClick} style={style}>
      {children}
    </button>
  );
}

/** Empty-state placeholder for a section with nothing to show yet. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "rgba(255,255,255,0.4)",
        fontStyle: "italic",
        padding: "6px 0",
      }}
    >
      {children}
    </div>
  );
}

/** Root wrapper giving every panel consistent padding, font, and scroll. */
export function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 14,
        maxHeight: "100%",
        overflow: "auto",
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        color: "rgba(255,255,255,0.92)",
      }}
    >
      {children}
    </div>
  );
}
