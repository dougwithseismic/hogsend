"use client";

/**
 * `VisuallyHidden` — visually hides content while keeping it available to
 * screen readers. Exported for headless users building their own a11y markup.
 */

import type { ReactNode } from "react";

const STYLE: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface VisuallyHiddenProps {
  children: ReactNode;
}

export function VisuallyHidden({ children }: VisuallyHiddenProps): ReactNode {
  return <span style={STYLE}>{children}</span>;
}
