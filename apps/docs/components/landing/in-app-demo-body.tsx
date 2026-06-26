"use client";

import { useState } from "react";
import { Card } from "@/components/ds/card";
import { EmailCapture } from "./email-capture";
import { InAppDemoLive } from "./in-app-demo-live";

/**
 * The two-column body of the home live demo, in ONE section:
 *
 *   LEFT  — the real sign-up: a PostHog-shaped qualifier (questions) + email.
 *           This is the dogfood loop — `docs.subscribed` → the dogfood
 *           `docs-subscriber` journey (real welcome series from hello@hogsend.com
 *           + day-10 check-in → referral / setup-offer + lead alerts), and the
 *           qualifier answers flushed to `/api/profile` as contact properties.
 *   RIGHT — the in-app loop, UNLOCKED by that sign-up (not anonymous): fire a
 *           real lifecycle event, watch the journey drop a notification.
 *
 * One sign-up proves both payoffs — a real email AND the live in-app loop. The
 * sign-up state is lifted here and passed down (the in-app column gates on it).
 */
export function InAppDemoBody() {
  const [signedUp, setSignedUp] = useState(false);
  const [name, setName] = useState<string | undefined>(undefined);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* LEFT — qualifier + email sign-up (feeds the dogfood) */}
      <Card className="flex flex-col p-6">
        <span className="kicker mb-3 block">Get the welcome series</span>
        <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
          Answer four questions. Get a real email.
        </h3>
        <p className="mt-1.5 text-sm text-white/55 leading-6">
          Tell us about your stack — PostHog, lifecycle email, what you build —
          and drop your email. A stock create-hogsend app running in production
          ingests the event, runs its welcome journey, and sends from
          hello@hogsend.com a few seconds later. That first email opens a real
          welcome series over the days that follow.
        </p>
        <EmailCapture
          hideHeading
          qualifyFirst
          placement="hero"
          className="mt-6"
          onSubscribed={(info) => {
            setSignedUp(true);
            if (info.name) setName(info.name);
          }}
        />
        <p className="mt-4 text-[12px] text-white/40 leading-5">
          Same engine, same journey code you scaffold · unsubscribe is one
          click.
        </p>
      </Card>

      {/* RIGHT — the in-app loop, unlocked by the sign-up (not anonymous) */}
      <InAppDemoLive signedUp={signedUp} name={name} />
    </div>
  );
}
