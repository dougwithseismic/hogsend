"use client";

/**
 * In-house ~Radix-style `Slot` (no Radix dep) — merges the component's props
 * onto a single child element when `asChild` is used. Powers override-surface
 * layer 4: a consumer renders their own element and we fold our props
 * (handlers, data-*, aria, className) onto it.
 */

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type ReactElement,
  type Ref,
} from "react";

export interface SlotProps {
  children?: React.ReactNode;
  [key: string]: unknown;
}

function mergeClassNames(a: unknown, b: unknown): string | undefined {
  const joined = [a, b]
    .filter((x) => typeof x === "string")
    .join(" ")
    .trim();
  return joined.length > 0 ? joined : undefined;
}

/** Merge our props onto the single child element. */
export const Slot = forwardRef<HTMLElement, SlotProps>(function Slot(
  { children, ...slotProps },
  ref,
) {
  if (!isValidElement(children)) {
    // Slot requires exactly one valid element child.
    return null;
  }
  const child = Children.only(children) as ReactElement<
    Record<string, unknown> & { ref?: Ref<unknown> }
  >;
  const childProps = child.props;

  const merged: Record<string, unknown> = { ...slotProps, ...childProps };

  // className concatenation (ours first, child wins specificity order).
  const className = mergeClassNames(slotProps.className, childProps.className);
  if (className) merged.className = className;

  // Compose event handlers (call ours, then the child's).
  for (const key of Object.keys(slotProps)) {
    if (!/^on[A-Z]/.test(key)) continue;
    const ours = slotProps[key];
    const theirs = childProps[key];
    if (typeof ours === "function" && typeof theirs === "function") {
      merged[key] = (...args: unknown[]) => {
        (ours as (...a: unknown[]) => void)(...args);
        (theirs as (...a: unknown[]) => void)(...args);
      };
    }
  }

  merged.ref = ref;
  return cloneElement(child, merged);
});
