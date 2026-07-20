import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Maps an email-send status to a badge variant + colour. Engine statuses:
 * queued | rendered | sent | delivered | opened | clicked | bounced |
 * complained | failed | suppressed.
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
  // Policy-gated before dispatch (preference suppression / test-mode block) —
  // a dim terminal, deliberately NOT destructive: nothing failed, the engine
  // chose not to send.
  suppressed: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.03] text-white/45",
  },
  // Journey-instance statuses (same single-accent vocabulary as the email
  // statuses above; `failed` is shared and stays destructive below).
  active: {
    variant: "outline",
    className: "border-white/30 bg-white/[0.12] text-white",
  },
  waiting: {
    variant: "outline",
    className: "border-white/15 bg-white/[0.05] text-white/60",
  },
  completed: {
    variant: "outline",
    className: "border-white/20 bg-white/[0.08] text-white/90",
  },
  exited: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.03] text-white/45",
  },
  // Campaign (broadcast) statuses — same single-accent vocabulary. `sending` is
  // the live/bright state; `scheduled` is informational; `canceled`/`expired`
  // are dim terminals (`sent`/`queued`/`failed` are shared with the rows above).
  scheduled: {
    variant: "outline",
    className: "border-white/15 bg-white/[0.05] text-white/70",
  },
  sending: {
    variant: "outline",
    className: "border-white/30 bg-white/[0.12] text-white",
  },
  canceled: {
    variant: "outline",
    className: "border-white/[0.08] bg-white/[0.03] text-white/45",
  },
  expired: {
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
