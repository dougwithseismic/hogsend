import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Generic surface card: 6px radius, white/1.5% fill, white/8 hairline border,
 * 24px padding. Border brightens to white/15 on hover.
 */
export function Card({ children, className }: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-md border border-white/[0.08] bg-white/[0.015] p-6",
        "text-white transition-colors duration-200 hover:border-white/15",
        className,
      )}
    >
      {children}
    </div>
  );
}
