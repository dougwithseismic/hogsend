import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Maps an email-send status to a badge variant + colour. Engine statuses:
 * queued | rendered | sent | delivered | opened | clicked | bounced |
 * complained | failed.
 */
const STATUS_STYLES: Record<
  string,
  { variant: BadgeProps["variant"]; className?: string }
> = {
  delivered: {
    variant: "outline",
    className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  },
  opened: {
    variant: "outline",
    className: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  },
  clicked: {
    variant: "outline",
    className: "border-violet-500/40 text-violet-600 dark:text-violet-400",
  },
  sent: { variant: "secondary" },
  rendered: { variant: "secondary" },
  queued: { variant: "secondary" },
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
