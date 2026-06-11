import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

/**
 * External documentation link styled as a button. Opens in a new tab. Used in
 * empty states and the onboarding card to point first-time users at the guides.
 */
export function DocLink({
  href,
  children,
  variant = "outline",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "outline" | "default" | "ghost";
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant, size: "sm" }), className)}
    >
      {children}
      <ArrowUpRight
        strokeWidth={2}
        className="h-3.5 w-3.5 shrink-0 opacity-70 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
      />
    </a>
  );
}
