import { Bell } from "lucide-react";
import { PillBadge } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { Section, SectionHeading } from "@/components/ds/section";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { InAppDemoLive } from "./in-app-demo-live";
import { IN_APP_SRC } from "./in-app-demo-src";

/**
 * InAppDemo — the home-page live-demo section: the product demonstrating itself
 * in real time. Replaces the older email-round-trip `LiveDemo`. A first-party
 * event fires, a deployed journey turns it into an in-app notification, and it
 * lands on the page (and in the nav bell) within seconds — no login.
 *
 * This is a SERVER component: it renders the async `<CodeWindow>` (server-side
 * Shiki) and passes it as a prop into the client `<InAppDemoLive>`, the same
 * interleaving the survey docs page uses to avoid the async-RSC-in-client trap
 * (React #482). The demo journeys it fires are already live on t.hogsend.com.
 */
export function InAppDemo() {
  return (
    <Section id="live-demo">
      <SectionHeading
        align="center"
        eyebrow="Live demo"
        title="The product, running on itself"
        subtitle="Fire a real lifecycle event and watch a journey turn it into a notification in real time — no login, keyed to one identity end to end. The same engine and journey code you scaffold."
      />
      <div className="relative mt-10">
        {/* red atmospheric bloom (the CodeWindow idiom) */}
        <div
          aria-hidden="true"
          className="-inset-x-12 -top-10 pointer-events-none absolute h-48"
          style={{
            background:
              "radial-gradient(55% 55% at 50% 0%, rgba(246,72,56,0.12), transparent 70%)",
            filter: "blur(40px)",
          }}
        />
        <div className="relative">
          {isHogsendConfigured ? (
            <InAppDemoLive
              codePanel={
                <CodeWindow
                  filename="src/journeys/docs-inapp-demo.ts"
                  code={IN_APP_SRC}
                />
              }
            />
          ) : (
            <GatedNotice />
          )}
        </div>
      </div>
    </Section>
  );
}

/** Shown when no engine is wired (e.g. a build without the NEXT_PUBLIC vars) so
 *  the page still builds and renders rather than erroring. */
function GatedNotice() {
  return (
    <Card className="mx-auto max-w-2xl p-6 text-center">
      <div className="mb-3 flex items-center justify-center gap-3">
        <span className="kicker block">Live demo</span>
        <PillBadge>
          <Bell className="size-3.5" strokeWidth={1.5} />
          Offline here
        </PillBadge>
      </div>
      <p className="text-sm text-white/55 leading-6">
        The live demo is dormant on this build — no engine is wired in. Set{" "}
        <code className="font-mono text-white/60">
          NEXT_PUBLIC_HOGSEND_API_URL
        </code>{" "}
        and a <code className="font-mono text-white/60">pk_</code> publishable
        key whose allowed origins include this site, and it goes live.
      </p>
    </Card>
  );
}
