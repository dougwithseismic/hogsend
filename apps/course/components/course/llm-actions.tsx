"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
  ChatGptMark,
  ClaudeMark,
  PerplexityMark,
} from "@/components/course/llm-logos";

/**
 * "Do something with this text in an LLM" action row. A Copy button plus, when
 * `send` is set, one-click hand-offs to Claude, ChatGPT, and Perplexity that
 * open a new chat pre-filled with an instruction + the content. Used under every
 * video transcript (copy + all three) and at the top of every lesson as
 * "Copy for LLM" (copy only). Client component — clipboard + window.open.
 */

/** Services keep a healthy margin under real address-bar limits; Copy is always
 *  the full text, so nothing is lost even when a send is trimmed. */
const URL_TEXT_CAP = 7000;

type Sender = {
  name: string;
  Mark: () => React.ReactNode;
  href: (q: string) => string;
};

const SENDERS: Sender[] = [
  {
    name: "Claude",
    Mark: ClaudeMark,
    href: (q) => `https://claude.ai/new?q=${q}`,
  },
  {
    name: "ChatGPT",
    Mark: ChatGptMark,
    href: (q) => `https://chatgpt.com/?q=${q}`,
  },
  {
    name: "Perplexity",
    Mark: PerplexityMark,
    href: (q) => `https://www.perplexity.ai/search?q=${q}`,
  },
];

const BTN =
  "inline-flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.02] px-2.5 py-1.5 font-medium text-white/70 text-xs transition-colors hover:border-white/25 hover:text-white";

export function LlmActions({
  text,
  copyLabel = "Copy",
  prompt = "",
  send = false,
}: {
  /** The content (transcript or lesson prose). */
  text: string;
  copyLabel?: string;
  /** Instruction prefixed to the payload for copy + sends. */
  prompt?: string;
  /** Also show the Claude / ChatGPT / Perplexity hand-off buttons. */
  send?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const payload = prompt ? `${prompt}\n\n${text}` : text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (insecure context / permissions) — no-op.
    }
  }

  const sendQuery = encodeURIComponent(
    prompt
      ? `${prompt}\n\n${text.slice(0, URL_TEXT_CAP)}`
      : text.slice(0, URL_TEXT_CAP),
  );

  return (
    <div className="not-prose flex flex-wrap items-center gap-2">
      <button type="button" onClick={copy} className={BTN}>
        {copied ? (
          <Check className="size-3.5 text-good" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? "Copied" : copyLabel}
      </button>

      {send
        ? SENDERS.map(({ name, Mark, href }) => (
            <a
              key={name}
              href={href(sendQuery)}
              target="_blank"
              rel="noreferrer"
              className={BTN}
              aria-label={`Open in ${name}`}
            >
              <Mark />
              {name}
            </a>
          ))
        : null}
    </div>
  );
}
