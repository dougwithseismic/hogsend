import { createJourneyTest } from "@hogsend/testing";
import { describe, expect, it } from "vitest";
import { qualifiedLeads } from "./qualified-leads.js";

/**
 * Proves the refinement example is SAFE on a fresh scaffold: no provider
 * package, no API key, no network, no database. `refineContact` runs for real
 * here and comes back `{ status: "skipped", reason: "no_provider" }` — the
 * reaction checkpoints it and finishes cleanly. (The placeholder env this
 * needs — the engine's main entry validates env at import — is injected by
 * vitest.config.ts; nothing is dialled.)
 */

// A bucket reaction IS a journey (`.on()` desugars to `defineJourney`), so the
// journey harness drives it directly.
const [onEnter] = qualifiedLeads.reactions;
if (!onEnter) throw new Error("qualified-leads has no enter reaction");

const user = { id: "lead-1", email: "lead@example.dev", properties: {} };

describe("qualified-leads enter reaction", () => {
  it("handles the no-provider skip without throwing", async () => {
    const test = createJourneyTest(onEnter, { user });

    await test.run();

    expect(test.effects.checkpoints.map((c) => c.label)).toContain(
      "refine-skipped:no_provider",
    );
    // Inert means inert: no sends, no cross-journey triggers.
    expect(test.mailbox.messages).toHaveLength(0);
    expect(test.effects.triggers).toHaveLength(0);
  });

  it("replays a recorded verdict instead of computing again", async () => {
    // Seeding the `once` bag simulates a durable replay: the first run
    // already recorded the vendor's answer. If the handler called
    // `refineContact` again it would come back `no_provider` here — the
    // `refined:refined` checkpoint proves the recorded result won verbatim.
    const test = createJourneyTest(onEnter, {
      user,
      once: { refine: { status: "refined", properties: {} } },
    });

    await test.run();

    expect(test.effects.checkpoints.map((c) => c.label)).toContain(
      "refined:refined",
    );
  });
});
