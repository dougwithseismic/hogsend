import type { ReactElement } from "react";
import { render } from "react-email";

/**
 * Render an SMS template component to plain text. Unlike email (which keeps rich
 * HTML), SMS is text-only over the wire, so this is the single render path.
 *
 * `react-email`'s plain-text renderer emits generous blank lines suited to
 * email; SMS bodies must be compact (segment-billed), so trailing whitespace is
 * trimmed and runs of 3+ newlines are collapsed to a paragraph break.
 */
export async function renderSmsToText(element: ReactElement): Promise<string> {
  const raw = await render(element, { plainText: true });
  return collapseWhitespace(raw);
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n") // strip trailing spaces on each line
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to one paragraph gap
    .trim();
}
