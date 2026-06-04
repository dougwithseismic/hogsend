import type { JSX } from "react";
import { cn } from "@/lib/cn";

type EyebrowProps = {
  children: React.ReactNode;
  tone?: "dark" | "light";
  className?: string;
};

export function Eyebrow({
  children,
  tone = "dark",
  className,
}: EyebrowProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded px-2 py-1",
        tone === "light"
          ? "bg-black text-white"
          : "border border-white/10 bg-white/5 text-white/80",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-[7px] shrink-0 rounded-[2px] bg-accent"
      />
      <span className="eyebrow">{children}</span>
    </span>
  );
}

type TagPillProps = {
  children: React.ReactNode;
  tone?: "dark" | "light";
  className?: string;
};

export function TagPill({
  children,
  tone = "dark",
  className,
}: TagPillProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-3 py-1.5 text-xs",
        tone === "light"
          ? "bg-black/[0.04] text-black/70"
          : "bg-white/[0.06] text-white/80",
        className,
      )}
    >
      {children}
    </span>
  );
}
