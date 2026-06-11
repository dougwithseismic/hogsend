import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Maps an email-send status to a badge variant + colour. Engine statuses:
 * queued | rendered | sent | delivered | opened | clicked | bounced |
 * complained | failed.
 *
 * Crimzon is single-accent: engagement depth is encoded as progressively
 * brighter white chips; red is reserved for failure states.
 */
const STATUS_STYLES: Record<
  string,
  { variant: BadgeProps["variant"]; className?: string }
> = {
  delivered: {
    variant: "outline",
    className: "border-white/15 bg-white/[0.06] text-white/80",
  },
  opened: {
    variant: "outline",
    className: "border-white/20 bg-white/[0.08] text-white/90",
  },
  clicked: {
    variant: "outline",
    className: "border-white/30 bg-white/[0.12] text-white",
  },
  sent: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.04] text-white/50",
  },
  rendered: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.04] text-white/50",
  },
  queued: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.04] text-white/50",
  },
  bounced: { variant: "destructive" },
  complained: { variant: "destructive" },
  failed: { variant: "destructive" },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { variant: "outline" as const };
  return (
    <Badge
      variant={style.variant}
      className={cn("capitalize", style.className)}
    >
      {status}
    </Badge>
  );
}
