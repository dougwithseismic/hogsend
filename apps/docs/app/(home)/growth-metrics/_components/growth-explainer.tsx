"use client";

import type { JSX } from "react";
import { BlendedCac } from "./blended-cac";
import { CurrencyProvider, CurrencyToggle, GlossaryProvider } from "./calc-kit";
import { Efficiency } from "./efficiency";
import { Glossary } from "./glossary";
import { GrowthLoop } from "./growth-loop";
import { GrowthStoreProvider } from "./growth-store";
import { HogsendLifecycle } from "./hogsend-lifecycle";
import { Intake } from "./intake";
import { InteractionMap } from "./interaction-map";
import { MasterFrame } from "./master-frame";
import { RetentionVirality } from "./retention-virality";
import { Tracking } from "./tracking";
import { UnitEconomics } from "./unit-economics";

/**
 * GrowthExplainer — the interactive body of the /growth-metrics page.
 *
 * Three providers wrap everything: CurrencyProvider (one £/$/€ choice shared by
 * every money readout, exposed via the sticky toggle), GlossaryProvider (the
 * single floating term tooltip), and GrowthStoreProvider (the shared input
 * model — the "Start here" intake derives the jargon and seeds every
 * downstream calculator, each still independently editable).
 */
export function GrowthExplainer(): JSX.Element {
  return (
    <CurrencyProvider>
      <GlossaryProvider>
        <GrowthStoreProvider>
          <div className="sticky top-20 z-30 border-white/[0.08] border-y bg-ink/80 backdrop-blur-md">
            <div className="container-page flex items-center justify-end gap-3 py-2.5">
              <span className="text-sm text-white/50">Currency</span>
              <CurrencyToggle />
            </div>
          </div>

          <Intake />
          <MasterFrame />
          <Tracking />
          <UnitEconomics />
          <RetentionVirality />
          <GrowthLoop />
          <BlendedCac />
          <Efficiency />
          <InteractionMap />
          <HogsendLifecycle />
          <Glossary />
        </GrowthStoreProvider>
      </GlossaryProvider>
    </CurrencyProvider>
  );
}
