/**
 * POSIX shell quoting for the sandbox build host.
 *
 * `ExecFn` is argv — no shell — but Railway's `sandboxExec` takes a single
 * command STRING, so something has to join argv back into shell text. That
 * join is a shell-injection seam: several of the values crossing it derive
 * from tenant-controlled input (image tags, archive-derived paths), and an
 * unquoted `$(…)` in one of them would execute on a host that holds registry
 * credentials. Every argument therefore passes through {@link quoteShellArg},
 * and the property is proven against a REAL bash in the test suite (spaces,
 * quotes, `$()`, backticks, semicolons, newlines all arrive verbatim).
 */

/**
 * Wrap one argument in single quotes, escaping embedded single quotes as
 * `'\''` (close the quote, emit a literal quote, reopen). Inside single
 * quotes POSIX shells perform NO expansion of any kind — no `$`, no
 * backticks, no `\`, no globbing — so this is a complete defence, not a
 * character denylist. Newlines are legal inside single quotes and survive
 * as-is.
 *
 * The one thing single quotes cannot carry is a NUL byte, which no argv can
 * carry either; it is refused rather than silently truncated at the first
 * NUL, because a truncated argument is exactly how a check gets bypassed.
 */
export function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("shell argument contains a NUL byte");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One argv rendered as a shell command, every element quoted — including
 * the command itself, which can be a path with spaces. */
export function renderArgv(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellArg).join(" ");
}
