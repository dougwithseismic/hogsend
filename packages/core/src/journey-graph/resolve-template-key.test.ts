import { describe, expect, it } from "vitest";
import { resolveTemplateKeyFromConst } from "./resolve-template-key.js";

describe("resolveTemplateKeyFromConst", () => {
  // The dogfood registry that surfaced the bug: slash-namespaced keys.
  const slashKeys = [
    "docs/welcome",
    "docs/build",
    "docs/recipes",
    "docs/agents",
    "docs/community",
    "docs/checkin",
    "docs/setup-offer",
  ];

  it("matches a slash-namespaced key from an UPPER_SNAKE const name", () => {
    expect(resolveTemplateKeyFromConst("DOCS_WELCOME", slashKeys)).toBe(
      "docs/welcome",
    );
    expect(resolveTemplateKeyFromConst("DOCS_CHECKIN", slashKeys)).toBe(
      "docs/checkin",
    );
  });

  it("matches a MIXED separator key (slash + hyphen)", () => {
    expect(resolveTemplateKeyFromConst("DOCS_SETUP_OFFER", slashKeys)).toBe(
      "docs/setup-offer",
    );
  });

  it("resolves every send node of a slash-namespaced journey (no sends needed)", () => {
    const constNames = [
      "DOCS_WELCOME",
      "DOCS_BUILD",
      "DOCS_RECIPES",
      "DOCS_AGENTS",
      "DOCS_COMMUNITY",
      "DOCS_CHECKIN",
    ];
    for (const name of constNames) {
      expect(resolveTemplateKeyFromConst(name, slashKeys)).toBeDefined();
    }
  });

  it("still matches hyphen and underscore registries (back-compat)", () => {
    expect(
      resolveTemplateKeyFromConst("ACTIVATION_NUDGE", ["activation-nudge"]),
    ).toBe("activation-nudge");
    expect(resolveTemplateKeyFromConst("WELCOME_BACK", ["welcome_back"])).toBe(
      "welcome_back",
    );
  });

  it("falls back to the longest unique segment-prefix key", () => {
    expect(
      resolveTemplateKeyFromConst("ACTIVATION_NUDGE_SERIES", [
        "activation",
        "activation-nudge",
      ]),
    ).toBe("activation-nudge");
  });

  it("returns undefined for an unknown const name", () => {
    expect(resolveTemplateKeyFromConst("NOPE_MISSING", slashKeys)).toBe(
      undefined,
    );
  });

  it("returns undefined on an ambiguous exact match rather than guessing", () => {
    expect(
      resolveTemplateKeyFromConst("DOCS_WELCOME", [
        "docs/welcome",
        "docs-welcome",
      ]),
    ).toBe(undefined);
  });

  it("does not over-match a longer key as a prefix", () => {
    // `DOCS_WELCOME` must not resolve to `docs/welcome-back` (extra segment).
    expect(
      resolveTemplateKeyFromConst("DOCS_WELCOME", ["docs/welcome-back"]),
    ).toBe(undefined);
  });
});
