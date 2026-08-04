import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { PROVISION_STEP_LABELS } from "@/src/lib/environment-detail";
import type { ProvisionProgress } from "@/src/lib/tenant-access";
import { TimeAgo } from "./time-ago";

/**
 * What a customer sees before their instance is theirs to use.
 *
 * On the page itself rather than behind a drawer: someone waiting on a stack
 * should not have to open anything to find out how it is going. It is the only
 * thing on the page with a deadline, so it takes the space.
 *
 * The state, the step and the "we are retrying" promise all come from
 * `deriveProvisionProgress`, which reads the sweeps' own constants — so this
 * card claims a retry only where a sweep would really re-drive, and claims a
 * human only where the alert sweep would really page one.
 */
export function ProvisioningCard({
  progress,
  now,
}: {
  progress: ProvisionProgress;
  now: Date;
}): JSX.Element {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-medium text-white tracking-[-0.02em]">
        {progress.state === "ready"
          ? "Finishing your login"
          : "Setting up your instance"}
      </h2>
      {progress.step ? (
        <p className="text-sm text-white/70 leading-6">
          {PROVISION_STEP_LABELS[progress.step]}
          {progress.since ? (
            <>
              {" "}
              — since <TimeAgo at={progress.since} now={now} />
            </>
          ) : null}
          . <span className="font-mono text-white/45">({progress.step})</span>
        </p>
      ) : null}
      <p className="max-w-prose text-sm text-white/60 leading-6">
        {progress.state === "ready"
          ? "Your instance is running, and we are still minting its Studio login. We re-drive that automatically; it appears here when it lands."
          : progress.message}
      </p>
    </Card>
  );
}
