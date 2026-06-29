"use client";

import { useHogsend } from "@hogsend/react";
import { useEffect, useState } from "react";
import { Card } from "@/components/ds/card";
import { DemoTrace } from "./demo-trace";
import { EmailCapture } from "./email-capture";
import { InAppDemoLive } from "./in-app-demo-live";

// localStorage keys shared with the try-it demo + the site banner greeting.
// `hs-demo-email` doubles as the "already signed up" flag (see try-it-demo.tsx
// and email-capture.tsx, which writes them on a successful subscribe).
const NAME_KEY = "hs-demo-name";
const EMAIL_KEY = "hs-demo-email";

/**
 * The two-column body of the home live demo, in ONE section:
 *
 *   LEFT  — the real sign-up: a PostHog-shaped qualifier (questions) + email.
 *           This is the dogfood loop — `docs.subscribed` → the dogfood
 *           `docs-subscriber` journey (real welcome series from hello@hogsend.com
 *           + day-10 check-in → referral / setup-offer + lead alerts), and the
 *           qualifier answers flushed to `/api/profile` as contact properties.
 *           A return visitor who already signed up skips the form entirely.
 *   RIGHT — the in-app loop, UNLOCKED by that sign-up (not anonymous): fire a
 *           real lifecycle event, watch the journey drop a notification.
 *
 * One sign-up proves both payoffs — a real email AND the live in-app loop. The
 * sign-up state is lifted here and passed down (the in-app column gates on it).
 */
export function InAppDemoBody() {
  const [signedUp, setSignedUp] = useState(false);
  const [name, setName] = useState<string | undefined>(undefined);
  // The last event fired in the in-app column + a monotonic nonce — bumping the
  // nonce replays the trace band below for that event (see DemoTrace). Idle at
  // nonce 0, it shows the settled welcome run as a teaser.
  const [fired, setFired] = useState<{ event: string; nonce: number }>({
    event: "demo.welcome",
    nonce: 0,
  });
  // A return visitor who already signed up. Read client-side only (localStorage
  // is browser-only), so the first paint matches the server (the form) and then
  // hydrates to the "you're in" state for known visitors.
  const [returning, setReturning] = useState(false);
  // The in-app client's own anon id (hs_anon_id) — handed to EmailCapture so the
  // sign-up can trigger the email-verified fold of this browser's demo activity
  // onto the contact (see web-link.ts in hogsend-dogfood).
  const { client } = useHogsend();

  useEffect(() => {
    try {
      const savedEmail = window.localStorage.getItem(EMAIL_KEY);
      if (savedEmail) {
        const savedName = window.localStorage.getItem(NAME_KEY);
        setSignedUp(true);
        setReturning(true);
        if (savedName) setName(savedName);
      }
    } catch {
      // Private mode / storage blocked — fall through to the form.
    }
  }, []);

  function startOver() {
    try {
      window.localStorage.removeItem(EMAIL_KEY);
      window.localStorage.removeItem(NAME_KEY);
    } catch {
      // Best-effort — the in-session reset still re-shows the form.
    }
    setReturning(false);
    setSignedUp(false);
    setName(undefined);
  }

  return (
    <>
      {/* `lg:items-start` is load-bearing: the in-app column is tall (the feed
          caps at 720px), and without it the grid's default `stretch` forces the
          short sign-up card to that same height — leaving a huge empty box
          under the form. Start-aligning lets each column take its height. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* LEFT — sign-up, OR a "you're already in" card for return visitors */}
        <Card className="flex flex-col p-6">
          {returning ? (
            <>
              <span className="kicker mb-3 block">You&rsquo;re in</span>
              <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
                {name ? `Welcome back, ${name}.` : "Welcome back."}
              </h3>
              <p className="mt-1.5 text-sm text-white/55 leading-6">
                You already signed up — the welcome series is in your inbox, and
                the in-app loop on the right is unlocked. Fire an event and
                watch a journey drop a notification into the feed.
              </p>
              <button
                type="button"
                onClick={startOver}
                className="mt-6 self-start text-[13px] text-white/40 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/70"
              >
                Not you? Start over
              </button>
            </>
          ) : (
            <>
              <span className="kicker mb-3 block">Get the demo</span>
              <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
                First name, email — get the demo.
              </h3>
              <p className="mt-1.5 text-sm text-white/55 leading-6">
                Drop your first name and email and you&rsquo;re in. A stock
                create-hogsend app running in production ingests the event, runs
                its welcome journey, and sends from hello@hogsend.com a few
                seconds later — that first email opens a real welcome series.
                Then a couple quick questions, if you like.
              </p>
              <EmailCapture
                hideHeading
                qualifyAfter
                placement="hero"
                className="mt-6"
                hogsendAnonymousId={client.getDistinctId()}
                onSubscribed={(info) => {
                  setSignedUp(true);
                  if (info.name) setName(info.name);
                }}
              />
              <p className="mt-4 text-[12px] text-white/40 leading-5">
                Same engine, same journey code you scaffold · unsubscribe is one
                click.
              </p>
            </>
          )}
        </Card>

        {/* RIGHT — the in-app loop, unlocked by the sign-up (not anonymous) */}
        <InAppDemoLive
          signedUp={signedUp}
          name={name}
          onFire={(event) =>
            setFired((prev) => ({ event, nonce: prev.nonce + 1 }))
          }
        />
      </div>

      {/* The full-width "what just ran" band — replays the journey shape for
          the last-fired event: event → in-app send → fan-out to PostHog. */}
      <DemoTrace
        event={fired.event}
        nonce={fired.nonce}
        signedUp={signedUp}
        name={name}
      />
    </>
  );
}
