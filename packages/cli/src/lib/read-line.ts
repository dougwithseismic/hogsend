/**
 * One line from stdin, for the runs that have no terminal to prompt in.
 *
 * `hogsend signup --json` and any piped/CI run still have to get the emailed
 * code from somewhere, and the honest channel is the one every other tool
 * uses: `echo 123456 | hogsend signup --email me@acme.com --json`. clack's
 * prompts need a TTY and would either hang or throw there, so this is the
 * non-interactive half.
 *
 * Deliberately raw rather than `node:readline`: readline attaches handlers
 * that keep the process alive until it is explicitly closed, which is exactly
 * the class of bug that makes a CLI hang after printing its result.
 */
/**
 * The narrow slice of a readable stream this needs.
 *
 * Deliberately structural rather than `NodeJS.ReadableStream`: `process.stdin`
 * is a union of stream types whose `on` overloads do not unify, so naming the
 * three methods used is both more honest about the coupling and the only shape
 * a test can supply without building a real stream.
 */
export interface LineSource {
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  setEncoding?(encoding: string): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface ReadLineOptions {
  /** Injected in tests so no suite ever blocks on a real stdin. */
  stream?: LineSource;
  /** Ceiling on the wait. A pipe that never sends a line must not hang. */
  timeoutMs?: number;
}

/** Five minutes: long enough to fetch a code from an inbox, not forever. */
export const DEFAULT_STDIN_TIMEOUT_MS = 5 * 60_000;

export class StdinLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdinLineError";
  }
}

export function readLineFromStdin(
  options: ReadLineOptions = {},
): Promise<string> {
  const stream = options.stream ?? process.stdin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData as never);
      stream.removeListener("end", onEnd as never);
      stream.removeListener("error", onError as never);
      // Let the process exit even though stdin was read from.
      stream.pause?.();
      fn();
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at !== -1) {
        const line = buffer.slice(0, at);
        finish(() => resolve(line.trim()));
      }
    };

    // EOF with no newline is still a line — `printf 123456 | hogsend …` is a
    // reasonable thing to type, and refusing it would be pedantry.
    const onEnd = (): void => {
      const line = buffer.trim();
      finish(() =>
        line.length > 0
          ? resolve(line)
          : reject(new StdinLineError("no input was read from stdin")),
      );
    };

    const onError = (error: Error): void => finish(() => reject(error));

    const timer = setTimeout(() => {
      finish(() =>
        reject(new StdinLineError("timed out waiting for input on stdin")),
      );
    }, timeoutMs);
    // A pending timer must not be the reason a finished CLI stays alive.
    if (typeof timer.unref === "function") timer.unref();

    stream.setEncoding?.("utf8");
    stream.on("data", onData as never);
    stream.on("end", onEnd as never);
    stream.on("error", onError as never);
    stream.resume?.();
  });
}
