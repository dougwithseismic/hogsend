import type { Metadata } from "next";
import {
  HalftoneOverlay,
  ThermalCard,
  ThermalLayer,
} from "@/components/ds/thermal";

export const metadata: Metadata = {
  title: "Lab — thermal textures",
  robots: { index: false, follow: false },
};

/**
 * Internal playground for the thermal texture system. Not linked from nav.
 * The approved recipe: crimzon smoke pair + halftone on heroes; cards carry
 * the texture only at the frame (iron-bow rim + cursor kiss).
 */
export default function LabPage() {
  return (
    <main className="min-h-screen bg-[#050101] text-white">
      {/* Hero demo: texture bed + halftone riding the glow. */}
      <section className="relative overflow-hidden border-white/[0.08] border-b">
        <ThermalLayer strength={0.5} />
        <HalftoneOverlay />
        <div className="relative mx-auto max-w-5xl px-6 py-32">
          <p className="mb-4 font-mono text-white/40 text-xs uppercase tracking-[0.2em]">
            Lab / thermal
          </p>
          <h1 className="max-w-2xl font-medium text-5xl leading-[1.1] tracking-[-0.03em]">
            Lifecycle journeys that live in your repo
          </h1>
          <p className="mt-6 max-w-xl text-lg text-white/60">
            Generated thermal texture blended with screen, halftone drawn in
            code on top, morphing on an 18s counter-phase loop.
          </p>
        </div>
      </section>

      {/* Card demos: cursor reveal + border kiss. */}
      <section className="mx-auto max-w-5xl px-6 py-24">
        <div className="grid gap-4 md:grid-cols-3">
          <ThermalCard>
            <h3 className="font-medium text-xl tracking-[-0.02em]">
              Code-first journeys
            </h3>
            <p className="mt-2.5 text-base text-white/60 leading-6">
              Move the mouse — the texture lifts around the cursor and the
              hairline border picks up heat.
            </p>
          </ThermalCard>
          <ThermalCard strength={0.06}>
            <h3 className="font-medium text-xl tracking-[-0.02em]">
              Quieter variant
            </h3>
            <p className="mt-2.5 text-base text-white/60 leading-6">
              Lower resting strength — nearly invisible until you touch it.
            </p>
          </ThermalCard>
          <ThermalCard strength={0.16}>
            <h3 className="font-medium text-xl tracking-[-0.02em]">
              Louder variant
            </h3>
            <p className="mt-2.5 text-base text-white/60 leading-6">
              Higher resting strength for hero-adjacent cards.
            </p>
          </ThermalCard>
        </div>
      </section>
    </main>
  );
}
