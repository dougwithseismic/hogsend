import type { ExecFn, ExecOptions } from "./exec";

/**
 * A scripted `ExecFn` for tests: it records every invocation and answers with
 * whatever the script says, so a suite can prove "preflight refused ⇒ nothing
 * was pushed" without a docker daemon or a bash on PATH.
 *
 * Deliberately dumb — it runs nothing and inspects nothing. Which command is
 * which is decided by the ARGV the pipeline actually builds (`docker build`,
 * `docker push`, anything else = the preflight script), so a change to how a
 * command is assembled shows up here as a test that stops being scripted rather
 * than as a silently-passing mock.
 */

export interface FakeExecCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

export interface FakeExecScript {
  /** Shared sink, so a caller can hold the array it will assert on. */
  calls?: FakeExecCall[];
  /** Output every command emits unless a more specific field applies. */
  output?: string;
  /** Exit code every command returns unless a more specific field applies. */
  exitCode?: number;
  buildExitCode?: number;
  pushExitCode?: number;
  inspectExitCode?: number;
  /** Anything that is not `docker` — in this pipeline, the preflight gate. */
  preflightExitCode?: number;
  buildOutput?: string;
  pushOutput?: string;
  inspectOutput?: string;
  preflightOutput?: string;
}

type Kind = "build" | "push" | "inspect" | "preflight";

function kindOf(command: string, args: readonly string[]): Kind {
  if (command !== "docker") return "preflight";
  if (args[0] === "build") return "build";
  if (args[0] === "push") return "push";
  return "inspect";
}

export function createFakeExec(script: FakeExecScript = {}): ExecFn {
  const calls = script.calls ?? [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args: [...args], options });

    const kind = kindOf(command, args);
    const code =
      (kind === "build"
        ? script.buildExitCode
        : kind === "push"
          ? script.pushExitCode
          : kind === "inspect"
            ? script.inspectExitCode
            : script.preflightExitCode) ??
      script.exitCode ??
      0;
    const output =
      (kind === "build"
        ? script.buildOutput
        : kind === "push"
          ? script.pushOutput
          : kind === "inspect"
            ? script.inspectOutput
            : script.preflightOutput) ??
      script.output ??
      "";

    if (output) options?.onOutput?.(output);
    return { code, output, timedOut: false };
  };
  return exec;
}
