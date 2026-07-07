"use client";

import { useEffect, useState } from "react";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Card } from "@/components/ds/card";
import { signOut, useSession } from "@/lib/auth-client";
import { DemoTrace } from "./demo-trace";
import { InAppDemoLive } from "./in-app-demo-live";

/**
 * The home live demo, GATED behind a real sign-in (one account across
 * hogsend.com + course.hogsend.com). Signed out → the passwordless sign-in
 * (6-digit code / magic link, with a first name); signed in → the in-app loop,
 * fired as a first-class IDENTIFIED contact. Identity is the shared session, so
 * every demo event — and the link.clicked from its tracked notification — lands
 * on the same named contact (no anonymous "a visitor", no phantom-twin fork).
 */
export function InAppDemoBody() {
  const { data: session, isPending } = useSession();
  const signedIn = Boolean(session);
  const name = (session?.user.name ?? "").trim().split(/\s+/)[0] || undefined;
  const email = session?.user.email;

  // Latch: once the session has resolved even once, never show the loading
  // placeholder again. better-auth refetches the session on window refocus,
  // which flips `isPending` — without this, tabbing to your inbox for the OTP
  // code and back would unmount the sign-in form and wipe the code you typed.
  const [resolvedOnce, setResolvedOnce] = useState(false);
  useEffect(() => {
    if (!isPending) setResolvedOnce(true);
  }, [isPending]);
  const showLoading = isPending && !resolvedOnce;

  // The last event fired + a monotonic nonce — bumping it replays the trace
  // band below for that event (see DemoTrace).
  const [fired, setFired] = useState<{ event: string; nonce: number }>({
    event: "demo.welcome",
    nonce: 0,
  });
  const handleFire = (event: string) =>
    setFired((prev) => ({ event, nonce: prev.nonce + 1 }));

  // Post-sign-in return target = wherever the demo is embedded. Computed on the
  // client so SSR and first paint agree ("/" until mounted).
  const [returnPath, setReturnPath] = useState("/");
  useEffect(() => {
    setReturnPath(window.location.pathname + window.location.search);
  }, []);

  return (
    <>
      {showLoading ? (
        // Session still resolving (first load only) — a neutral placeholder so a
        // returning signed-in visitor never flashes the sign-in form. Latched so
        // a focus refetch can't re-trigger it and unmount an in-progress sign-in.
        <Card className="flex min-h-[220px] items-center justify-center p-6">
          <span className="text-sm text-white/40">Loading your session…</span>
        </Card>
      ) : signedIn ? (
        <>
          <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="kicker mb-2 block">You&rsquo;re in</span>
              <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
                {name ? `Welcome, ${name}.` : "Welcome."}
              </h3>
              <p className="mt-1.5 max-w-2xl text-sm text-white/55 leading-6">
                You&rsquo;re signed in — the same account works on the courses
                too. Fire a real lifecycle event below and a journey turns it
                into a notification, keyed to you end to end.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void signOut().then(() => window.location.reload());
              }}
              className="shrink-0 self-start text-[13px] text-white/40 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/70 sm:self-center"
            >
              Sign out
            </button>
          </Card>

          <div className="mt-6">
            <InAppDemoLive
              wide
              signedUp
              name={name}
              email={email}
              onFire={handleFire}
            />
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <Card className="flex flex-col p-6">
            <span className="kicker mb-3 block">Log in to try it live</span>
            <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
              Sign in — then fire a real event.
            </h3>
            <p className="mt-1.5 text-sm text-white/55 leading-6">
              One account across hogsend.com and the courses. We&rsquo;ll email
              you a 6-digit code — no password. Sign in and you become a real,
              named contact: fire a lifecycle event and watch a journey turn it
              into a notification in your bell, keyed to you.
            </p>
            <div className="mt-6">
              <SignInForm next={returnPath} githubEnabled={false} />
            </div>
            <p className="mt-4 text-[12px] text-white/40 leading-5">
              Same engine, same journey code you scaffold · one identity across
              web, email, and Discord.
            </p>
          </Card>

          <InAppDemoLive
            signedUp={false}
            name={undefined}
            onFire={handleFire}
          />
        </div>
      )}

      {/* The full-width "what just ran" band — replays the journey shape for the
          last-fired event. */}
      <DemoTrace
        event={fired.event}
        nonce={fired.nonce}
        signedUp={signedIn && !isPending}
        name={name}
      />
    </>
  );
}
