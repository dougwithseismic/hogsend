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
    // `lg:items-start` is load-bearing: the in-app column is tall (the feed caps
    // at 720px), and without it the grid's default `stretch` forces the short
    // sign-up card to that same height — leaving a huge empty box under the
    // form. Start-aligning lets each column take its natural height.
    <div className="grid items-start gap-6 lg:grid-cols-2">
      {/* LEFT — email-first sign-up (feeds the dogfood; qualifier comes after) */}
      <Card className="flex flex-col p-6">
        <span className="kicker mb-3 block">Get the demo</span>
        <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
          First name, email — get the demo.
        </h3>
        <p className="mt-1.5 text-sm text-white/55 leading-6">
          Drop your first name and email and you're in. A stock create-hogsend
          app running in production ingests the event, runs its welcome journey,
          and sends from hello@hogsend.com a few seconds later — that first
          email opens a real welcome series. Then a couple quick questions, if
          you like.
        </p>
        <EmailCapture
          hideHeading
          qualifyAfter
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
