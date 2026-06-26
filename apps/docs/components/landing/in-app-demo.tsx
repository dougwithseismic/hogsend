import { Bell } from "lucide-react";
import { PillBadge } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { InAppDemoBody } from "./in-app-demo-body";

/**
 * InAppDemo — the home-page live-demo section: the product demonstrating itself.
 * One section, two columns (`InAppDemoBody`): a real qualifier+email sign-up
 * that feeds the dogfood (real welcome series + segmentation + lead alerts), and
 * the in-app loop it unlocks (fire an event → a journey drops a notification in
 * the feed + the nav bell). The demo journeys are already live on t.hogsend.com.
 */
export function InAppDemo() {
  return (
    <Section id="live-demo">
      <SectionHeading
        align="center"
        eyebrow="Live demo"
        title="The product, running on itself"
        subtitle="Sign up and a real welcome series lands in your inbox — then fire an event and watch a notification land in your bell. Both run on the same journeys you'd scaffold, one identity end to end."
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
          {isHogsendConfigured ? <InAppDemoBody /> : <GatedNotice />}
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
