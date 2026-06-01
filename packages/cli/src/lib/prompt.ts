import { cancel, isCancel } from "@clack/prompts";

/**
 * Guard a clack prompt result. clack returns a cancellation symbol when the
 * user hits Ctrl-C / Esc; this unwraps the value or aborts the whole CLI
 * cleanly (exit 0 — a deliberate cancel, not an error).
 *
 * Re-export clack's `text`/`select`/`confirm`/`multiselect` from
 * `@clack/prompts` directly in command files; wrap each call in `bail()`.
 */
export function bail<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}
