import { Clock } from "lucide-react";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";

/**
 * Shown while a stack is still `requested`. The row exists and the placement
 * decision is made, but nothing has been deployed for it — and saying so is the
 * only honest thing to render next to a status chip that will not move on its
 * own.
 */
export function ProvisioningNote({ count }: { count: number }): JSX.Element {
  return (
    <Card className="flex items-start gap-4">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white/70">
        <Clock aria-hidden className="size-4" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium text-sm text-white tracking-[-0.02em]">
          {count === 1
            ? "One stack is requested and not yet built"
            : `${count} stacks are requested and not yet built`}
        </h3>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          A requested stack has a region, a database name and a Hatchet
          namespace reserved for it. The provisioner that turns that into a
          running API, worker, Postgres and Redis is not wired up yet, so the
          status stays at{" "}
          <span className="font-mono text-white/80">requested</span> until it
          is.
        </p>
      </div>
    </Card>
  );
}
