import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  assertReenrollmentAck,
  defaultBranchName,
  JOURNEY_ID_WITH_MULTIPLE,
  parsePromoteArgs,
  registerJourneyInIndex,
} from "../commands/blueprints.js";
import { camelCase } from "../lib/blueprint-codegen.js";

/**
 * Unit tests for the pure/testable pieces of `hogsend blueprints promote`:
 * the src/journeys/index.ts text insertion, the promote flag parser, and the
 * branch-name default. The full command flow (git branch, HTTP calls,
 * confirmation) is smoke-tested against a real running API separately.
 */

/** Fail the test if `source` is not syntactically valid TypeScript. */
function expectValidTs(source: string): void {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = (result.diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
  expect(errors).toEqual([]);
}

// Modeled on packages/create-hogsend/template/src/journeys/index.ts — the
// shape every scaffolded consumer app starts from (the insertion's source of
// truth).
const TEMPLATE_INDEX = `import type { DefinedJourney } from "@hogsend/engine";
import { aiOnboarding } from "./ai-onboarding.js";
import { feedbackCheckin } from "./feedback-checkin.js";
import { welcome } from "./welcome.js";

/**
 * All defined journeys for this app. Passed to \`createHogsendClient({ journeys })\`
 * and \`createWorker({ journeys })\`. Edit freely — this is your content.
 */
export const journeys: DefinedJourney[] = [
  aiOnboarding,
  welcome,
  feedbackCheckin,
];

// Re-export individual journeys for direct reference (tests, custom wiring).
export { aiOnboarding, feedbackCheckin, welcome };
`;

describe("registerJourneyInIndex", () => {
  it("inserts the import after the last existing import", () => {
    const result = registerJourneyInIndex(TEMPLATE_INDEX, "activation-nudge");
    expect(result).toContain(
      'import { activationNudge } from "./activation-nudge.js";',
    );
    const lastTemplateImport = result.indexOf('from "./welcome.js";');
    const newImport = result.indexOf("import { activationNudge }");
    expect(newImport).toBeGreaterThan(lastTemplateImport);
    // ...but before the doc comment / array, not appended at the bottom.
    expect(newImport).toBeLessThan(result.indexOf("export const journeys"));
  });

  it("adds the export name into the journeys array before the closing bracket", () => {
    const result = registerJourneyInIndex(TEMPLATE_INDEX, "activation-nudge");
    expect(result).toMatch(
      /export const journeys: DefinedJourney\[\] = \[[\s\S]*feedbackCheckin,\n {2}activationNudge,\n\];/,
    );
  });

  it("produces syntactically valid TypeScript", () => {
    expectValidTs(registerJourneyInIndex(TEMPLATE_INDEX, "activation-nudge"));
  });

  it("stays valid across repeated insertions (batch promote)", () => {
    let source = TEMPLATE_INDEX;
    source = registerJourneyInIndex(source, "first-journey");
    source = registerJourneyInIndex(source, "second-journey");
    expect(source).toContain(
      'import { firstJourney } from "./first-journey.js";',
    );
    expect(source).toContain(
      'import { secondJourney } from "./second-journey.js";',
    );
    expect(source).toMatch(/firstJourney,\n {2}secondJourney,\n\];/);
    expectValidTs(source);
  });

  it("handles an empty journeys array", () => {
    const source = `import type { DefinedJourney } from "@hogsend/engine";

export const journeys: DefinedJourney[] = [];
`;
    const result = registerJourneyInIndex(source, "welcome");
    expect(result).toContain('import { welcome } from "./welcome.js";');
    expect(result).toMatch(
      /journeys: DefinedJourney\[\] = \[\n {2}welcome,\n\];/,
    );
    expectValidTs(result);
  });

  it("adds a separating comma to a single-line array without a trailing comma", () => {
    const source = `import { a } from "./a.js";
export const journeys = [a];
`;
    const result = registerJourneyInIndex(source, "new-one");
    expect(result).toMatch(/\[a,\n {2}newOne,\n\];/);
    expectValidTs(result);
  });

  it("inserts the import at the top when the file has no imports", () => {
    const source = "export const journeys = [];\n";
    const result = registerJourneyInIndex(source, "welcome");
    expect(result.startsWith('import { welcome } from "./welcome.js";\n')).toBe(
      true,
    );
    expectValidTs(result);
  });

  it("throws when the journey file is already imported", () => {
    expect(() => registerJourneyInIndex(TEMPLATE_INDEX, "welcome")).toThrow(
      /already imports/,
    );
  });

  it("throws when the export name is already listed in the array", () => {
    // Imported under a different specifier but present in the array.
    const source = `import { welcome } from "./legacy/welcome-journey.js";
export const journeys = [
  welcome,
];
`;
    expect(() => registerJourneyInIndex(source, "welcome")).toThrow(
      /already listed/,
    );
  });

  it("throws when there is no journeys array to register into", () => {
    expect(() =>
      registerJourneyInIndex("export const foo = [];\n", "welcome"),
    ).toThrow(/could not find/);
  });

  it("also adds the export name to a trailing plain re-export block", () => {
    const result = registerJourneyInIndex(TEMPLATE_INDEX, "activation-nudge");
    expect(result).toMatch(
      /export \{ aiOnboarding, feedbackCheckin, welcome, activationNudge \};/,
    );
    expectValidTs(result);
  });

  it("does not treat a re-export-from statement as the re-export block", () => {
    const source = `import { a } from "./a.js";
export { a } from "./a.js";
export const journeys = [a];
`;
    const result = registerJourneyInIndex(source, "new-one");
    // The "export { a } from ..." line must be untouched.
    expect(result).toContain('export { a } from "./a.js";');
    expectValidTs(result);
  });

  it("does not silently corrupt the array from a same-line trailing comment after the last comma", () => {
    const source = `import { a } from "./a.js";
import { b } from "./b.js";
export const journeys = [
  a,
  b, // keep b last for now
];
`;
    const result = registerJourneyInIndex(source, "new-one");
    // No spurious comma creating an array hole between b and the new entry.
    expect(result).not.toMatch(/,\s*,/);
    expect(result).toMatch(/b, \/\/ keep b last for now\n {2}newOne,\n\];/);
    expectValidTs(result);
  });

  it("does not miscount a bracket inside a comment inside the array", () => {
    const source = `import { welcome } from "./welcome.js";
export const journeys = [
  // see docs] for details on ordering
  welcome,
];
`;
    const result = registerJourneyInIndex(source, "new-one");
    expect(result).toContain("// see docs] for details on ordering");
    expect(result).toMatch(/welcome,\n {2}newOne,\n\];/);
    // No trailing garbage left outside the array from a miscounted bracket.
    expect(result.trimEnd().endsWith("];")).toBe(true);
    expectValidTs(result);
  });
});

describe("parsePromoteArgs", () => {
  it("defaults cwd to the provided default and collects positional ids", () => {
    const flags = parsePromoteArgs(["bp-a", "bp-b"], "/default");
    expect(flags.cwd).toBe("/default");
    expect(flags.ids).toEqual(["bp-a", "bp-b"]);
    expect(flags.yes).toBe(false);
    expect(flags.dryRun).toBe(false);
    expect(flags.branch).toBeUndefined();
    expect(flags.journeyId).toBeUndefined();
  });

  it("honors --cwd, --yes, --dry-run, --branch, --journey-id", () => {
    const flags = parsePromoteArgs(
      [
        "bp-a",
        "--cwd",
        "/app",
        "--yes",
        "--dry-run",
        "--branch",
        "my-branch",
        "--journey-id",
        "nice-name",
      ],
      "/default",
    );
    expect(flags.cwd).toBe("/app");
    expect(flags.yes).toBe(true);
    expect(flags.dryRun).toBe(true);
    expect(flags.branch).toBe("my-branch");
    expect(flags.journeyId).toBe("nice-name");
    expect(flags.ids).toEqual(["bp-a"]);
  });

  it("accepts -y as shorthand for --yes", () => {
    expect(parsePromoteArgs(["-y"], "/d").yes).toBe(true);
  });

  it("de-duplicates repeated positional ids", () => {
    expect(parsePromoteArgs(["bp-a", "bp-a", "bp-b"], "/d").ids).toEqual([
      "bp-a",
      "bp-b",
    ]);
  });

  it("rejects --journey-id with multiple blueprint ids", () => {
    expect(() =>
      parsePromoteArgs(["bp-a", "bp-b", "--journey-id", "x"], "/d"),
    ).toThrow(JOURNEY_ID_WITH_MULTIPLE);
  });

  it("allows --journey-id with exactly one blueprint id", () => {
    const flags = parsePromoteArgs(["bp-a", "--journey-id", "x"], "/d");
    expect(flags.journeyId).toBe("x");
  });

  it("rejects a --journey-id that is not a safe file name", () => {
    expect(() =>
      parsePromoteArgs(["bp-a", "--journey-id", "../evil"], "/d"),
    ).toThrow(/invalid --journey-id/);
  });

  it("parses --allow-reenrollment (default false)", () => {
    expect(parsePromoteArgs(["bp-a"], "/d").allowReenrollment).toBe(false);
    expect(
      parsePromoteArgs(["bp-a", "--allow-reenrollment"], "/d")
        .allowReenrollment,
    ).toBe(true);
  });
});

describe("assertReenrollmentAck", () => {
  it("refuses a renaming --journey-id without the acknowledgment", () => {
    expect(() =>
      assertReenrollmentAck({
        blueprintId: "activation-nudge-blueprint",
        journeyId: "activation-nudge",
        allowReenrollment: false,
      }),
    ).toThrow(/--allow-reenrollment/);
  });

  it("allows a renaming --journey-id when acknowledged", () => {
    expect(() =>
      assertReenrollmentAck({
        blueprintId: "activation-nudge-blueprint",
        journeyId: "activation-nudge",
        allowReenrollment: true,
      }),
    ).not.toThrow();
  });

  it("needs no acknowledgment when the journey id matches the blueprint id", () => {
    expect(() =>
      assertReenrollmentAck({
        blueprintId: "activation-nudge",
        journeyId: "activation-nudge",
        allowReenrollment: false,
      }),
    ).not.toThrow();
  });
});

describe("defaultBranchName", () => {
  const now = new Date("2026-07-11T14:30:05.000Z");

  it("names a single-blueprint branch after the blueprint", () => {
    expect(defaultBranchName(["activation-nudge"], now)).toBe(
      "promote-blueprint-activation-nudge",
    );
  });

  it("timestamps a batch branch with the count", () => {
    expect(defaultBranchName(["a", "b"], now)).toBe(
      "promote-blueprints-2-2026-07-11T14-30-05",
    );
  });
});

describe("camelCase (shared with blueprint-codegen.ts)", () => {
  it("names imports/exports the way registerJourneyInIndex expects", () => {
    expect(camelCase("activation-nudge")).toBe("activationNudge");
    expect(camelCase("send_nudge.v2")).toBe("sendNudgeV2");
    expect(camelCase("2fast")).toBe("_2fast");
  });
});
