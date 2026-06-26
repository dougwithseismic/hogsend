"use client";

import { NotificationFeed, useHogsend } from "@hogsend/react";
import { Bell } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Card } from "@/components/ds/card";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

/**
 * Live in-app survey demo. The button fires `demo.survey`; a journey calls
 * `sendSurvey({ mode: "nps", property: "score", event: "demo.nps_submitted" })`,
 * which drops a survey card into the feed below (the same `in_app` feed the nav
 * bell polls). Answering the card captures `demo.nps_submitted` with `{ score }`
 * onto the spine, and a second journey reads that score and drops a thank-you
 * item — the loop closes on this page.
 *
 * Gated on `isHogsendConfigured` so the docs build (no engine wired) renders
 * nothing rather than erroring; the provider is pass-through when unconfigured.
 */
export function SurveyDemo({ codePanel }: { codePanel?: ReactNode }) {
  if (!isHogsendConfigured) return null;
  return <SurveyDemoLive codePanel={codePanel} />;
}

function SurveyDemoLive({ codePanel }: { codePanel?: ReactNode }) {
  const { capture, client } = useHogsend();
  const [firing, setFiring] = useState(false);

  async function fireSurvey() {
    if (firing) return;
    setFiring(true);
    try {
      // Fire the first-party event, then flush so it hits the engine
      // immediately (capture is batched). The journey inserts the survey card,
      // which the feed below picks up on its next poll.
      await capture("demo.survey", {});
      await client.flush();
    } finally {
      setFiring(false);
    }
  }

  return (
    <div className="my-8 grid gap-6 not-prose lg:grid-cols-[1fr_1fr]">
      <Card className="flex flex-col gap-5 p-6">
        <button
          type="button"
          onClick={fireSurvey}
          disabled={firing}
          className={cn(
            "group inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-sm transition-colors",
            "hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <Bell className="size-4 shrink-0" strokeWidth={1.5} />
          Send me a survey
        </button>
        <p className="text-[12px] text-white/40 leading-5">
          Fires <code className="font-mono text-white/60">demo.survey</code>.
          The NPS card lands in the feed below — answer it and a journey drops
          the thank-you item.
        </p>
        <NotificationFeed
          feedId="in_app"
          aria-label="In-app survey demo feed"
        />
      </Card>
      {codePanel ? (
        <div className="lg:sticky lg:top-24 lg:self-start">{codePanel}</div>
      ) : null}
    </div>
  );
}
