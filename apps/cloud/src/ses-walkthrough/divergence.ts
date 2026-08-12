import type { SesVerb } from "../ses/contract";
import { SesError, type SesErrorKind } from "../ses/types";

/**
 * The deliverable: a structural diff between what AWS answered and what
 * `FakeSesClient` answers for the same input.
 *
 * The standing rule this exists to enforce (PRD 11, DECISIONS §4): the Fake is
 * what every test in this stack runs against, so anywhere the Fake is more
 * permissive — or simply differently shaped — than AWS is a production-only bug
 * with a green test in front of it. PRD 02 shipped 1089 tests green while
 * carrying a cross-tenant suppression leak because the contract, the
 * implementation, the Fake and the tests all agreed with each other and all
 * four were wrong together. Only a real answer breaks that circle.
 *
 * Two design rules follow from that, and both are the opposite of what a test
 * harness would do:
 *
 *  - **Collect, never throw.** The first divergence is the least interesting
 *    one. A recorder that stopped there would need as many runs as there are
 *    defects, and each run creates and bills AWS resources.
 *  - **Compare errors on `kind`, never on the message.** That is the seam's own
 *    law (`SesErrorKind`): AWS rewords its prose and the Fake never matched it
 *    in the first place, so a message comparison would drown the report in
 *    noise and hide the one field callers actually branch on.
 */

/** What one call answered. A throw is an ANSWER here, not a failure. */
export type StepAnswer =
  | { outcome: "ok"; value: unknown }
  | { outcome: "error"; kind: SesErrorKind; message: string };

export type DivergenceReason =
  | "outcome"
  | "kind"
  | "presence"
  | "type"
  | "value";

export interface Divergence {
  verb: string;
  label: string;
  /** Dot path inside the answer. `""` is the answer itself. */
  path: string;
  reason: DivergenceReason;
  real: unknown;
  fake: unknown;
}

export type StepStatus = "compared" | "skipped";

export interface RecordedStep {
  verb: SesVerb;
  label: string;
  status: StepStatus;
  /** What was sent, already redacted. Printed verbatim in the report. */
  input?: unknown;
  real?: StepAnswer;
  fake?: StepAnswer;
  divergences: Divergence[];
  skipReason?: string;
  /** A human note — a sandbox caveat, a "not exercised and why". */
  note?: string;
}

export interface CompareStep<T> {
  verb: SesVerb;
  /** Distinguishes two uses of one verb. Defaults to the verb. */
  label?: string;
  input?: unknown;
  /**
   * Paths whose VALUE is legitimately different (an ARN carrying the real
   * account id, a message id, a timestamp). Their TYPE is still compared, so a
   * field that goes missing or turns null is still a divergence. `*` matches
   * one path segment, which is how an array index is covered.
   */
  volatile?: readonly string[];
  real: () => Promise<T>;
  fake: () => Promise<T>;
  note?: string;
}

export interface CompareResult<T> {
  /** True when the REAL call succeeded — the next step reads this. */
  ok: boolean;
  real?: T;
  fake?: T;
  divergences: Divergence[];
}

export class DivergenceRecorder {
  readonly steps: RecordedStep[] = [];

  get divergences(): Divergence[] {
    return this.steps.flatMap((step) => step.divergences);
  }

  /**
   * Run one verb against both clients and record the difference.
   *
   * The two clients are driven through the SAME sequence of calls, which is
   * what "seeded to the same state" means here: the Fake is not pre-loaded with
   * a guess about AWS's state, it is walked through the identical script, so at
   * every step it holds whatever the same history would produce.
   *
   * REAL first, deliberately. If the real call is going to fail, the Fake's
   * state must not have already moved past it.
   */
  async compare<T>(step: CompareStep<T>): Promise<CompareResult<T>> {
    const label = step.label ?? step.verb;
    const real = await settle(step.real);
    const fake = await settle(step.fake);

    const divergences = compareAnswers({
      verb: step.verb,
      label,
      real: real.answer,
      fake: fake.answer,
      ...(step.volatile ? { volatile: step.volatile } : {}),
    });

    this.steps.push({
      verb: step.verb,
      label,
      status: "compared",
      ...(step.input === undefined ? {} : { input: step.input }),
      real: real.answer,
      fake: fake.answer,
      divergences,
      ...(step.note === undefined ? {} : { note: step.note }),
    });

    return {
      ok: real.answer.outcome === "ok",
      ...(real.answer.outcome === "ok" ? { real: real.value as T } : {}),
      ...(fake.answer.outcome === "ok" ? { fake: fake.value as T } : {}),
      divergences,
    };
  }

  /** A verb the run deliberately did not exercise, and WHY. */
  skip(step: {
    verb: SesVerb;
    label?: string;
    reason: string;
    note?: string;
  }): void {
    this.steps.push({
      verb: step.verb,
      label: step.label ?? step.verb,
      status: "skipped",
      divergences: [],
      skipReason: step.reason,
      ...(step.note === undefined ? {} : { note: step.note }),
    });
  }
}

async function settle<T>(
  call: () => Promise<T>,
): Promise<{ answer: StepAnswer; value?: T }> {
  try {
    const value = await call();
    return { answer: { outcome: "ok", value: toPlain(value) }, value };
  } catch (thrown) {
    const error =
      thrown instanceof SesError
        ? thrown
        : new SesError(String(thrown), { kind: "unknown" });
    return {
      answer: {
        outcome: "error",
        kind: error.kind,
        message: error.message,
      },
    };
  }
}

/**
 * Compare two answers structurally.
 *
 * PURE, and exported for exactly that reason: it is the one piece of this
 * script whose correctness can be established without an AWS account, so it is
 * tested directly rather than through the walkthrough.
 */
export function compareAnswers(input: {
  verb: string;
  label: string;
  real: StepAnswer;
  fake: StepAnswer;
  volatile?: readonly string[];
}): Divergence[] {
  const { verb, label, real, fake } = input;
  const volatilePaths = input.volatile ?? [];

  if (real.outcome !== fake.outcome) {
    return [
      {
        verb,
        label,
        path: "",
        reason: "outcome",
        real: describe(real),
        fake: describe(fake),
      },
    ];
  }

  if (real.outcome === "error" && fake.outcome === "error") {
    // Kind only. The prose is AWS's to change and the Fake never matched it.
    return real.kind === fake.kind
      ? []
      : [
          {
            verb,
            label,
            path: "kind",
            reason: "kind",
            real: real.kind,
            fake: fake.kind,
          },
        ];
  }

  const divergences: Divergence[] = [];
  walk({
    path: "",
    real: (real as { value: unknown }).value,
    fake: (fake as { value: unknown }).value,
    volatilePaths,
    onDivergence: (found) => divergences.push({ verb, label, ...found }),
  });
  return divergences;
}

interface WalkInput {
  path: string;
  real: unknown;
  fake: unknown;
  volatilePaths: readonly string[];
  onDivergence: (found: {
    path: string;
    reason: DivergenceReason;
    real: unknown;
    fake: unknown;
  }) => void;
}

function walk(input: WalkInput): void {
  const { path, real, fake, volatilePaths, onDivergence } = input;

  if (typeName(real) !== typeName(fake)) {
    onDivergence({ path, reason: "type", real, fake });
    return;
  }

  // A volatile path's value is expected to differ (an account id inside an ARN,
  // a message id). Its TYPE was just checked, so a field that vanished or went
  // null is still reported — which is the case that actually matters.
  if (isVolatile(path, volatilePaths)) return;

  if (Array.isArray(real) && Array.isArray(fake)) {
    if (real.length !== fake.length) {
      onDivergence({ path, reason: "value", real, fake });
      return;
    }
    real.forEach((entry, index) => {
      walk({
        ...input,
        path: join(path, String(index)),
        real: entry,
        fake: fake[index],
      });
    });
    return;
  }

  if (isPlainObject(real) && isPlainObject(fake)) {
    const keys = new Set([...Object.keys(real), ...Object.keys(fake)]);
    for (const key of [...keys].sort()) {
      const inReal = key in real;
      const inFake = key in fake;
      if (inReal !== inFake) {
        onDivergence({
          path: join(path, key),
          reason: "presence",
          real: inReal ? real[key] : "<absent>",
          fake: inFake ? fake[key] : "<absent>",
        });
        continue;
      }
      walk({
        ...input,
        path: join(path, key),
        real: real[key],
        fake: fake[key],
      });
    }
    return;
  }

  if (!Object.is(real, fake)) {
    onDivergence({ path, reason: "value", real, fake });
  }
}

function isVolatile(path: string, patterns: readonly string[]): boolean {
  if (path === "") return false;
  const segments = path.split(".");
  return patterns.some((pattern) => {
    const parts = pattern.split(".");
    if (parts.length !== segments.length) return false;
    return parts.every(
      (part, index) => part === "*" || part === segments[index],
    );
  });
}

function join(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip everything that is not plain data.
 *
 * The seam already promises portable values, so this is a belt-and-braces pass
 * that also makes the report JSON-serialisable — a `Date` or an SDK object
 * sneaking through would compare by identity and read as a divergence.
 */
function toPlain(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

function describe(answer: StepAnswer): unknown {
  return answer.outcome === "ok"
    ? { outcome: "ok", value: answer.value }
    : { outcome: "error", kind: answer.kind, message: answer.message };
}
