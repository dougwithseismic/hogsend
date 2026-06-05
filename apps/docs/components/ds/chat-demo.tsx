"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

type ChatMessage = { from: "user" | "agent"; text: string };

type ChatDemoProps = {
  messages: Array<ChatMessage>;
  className?: string;
};

/**
 * Animated runtime panel: a dark inset card (matches Wispr's dark code cards on
 * cream) whose messages fade/slide in on a timed, looping reveal. The agent
 * accent is amber (glow), bubbles use lavender (dawn) — no green.
 */
export function ChatDemo({ messages, className }: ChatDemoProps) {
  // Number of messages currently revealed. Starts at 0, climbs to messages.length,
  // then loops back to 0 after a hold.
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (messages.length === 0) return;

    const STEP_MS = 1200; // gap between each message appearing
    const HOLD_MS = 2600; // pause once the full thread is shown before looping

    let timeout: ReturnType<typeof setTimeout>;

    function advance(current: number) {
      if (current < messages.length) {
        timeout = setTimeout(() => {
          setVisible(current + 1);
          advance(current + 1);
        }, STEP_MS);
      } else {
        timeout = setTimeout(() => {
          setVisible(0);
          advance(0);
        }, HOLD_MS);
      }
    }

    advance(0);
    return () => clearTimeout(timeout);
  }, [messages.length]);

  return (
    <div
      className={cn(
        "relative rounded-2xl border border-white/10 bg-ink p-5 md:p-6",
        className,
      )}
    >
      {/* panel header */}
      <div className="mb-5 flex items-center justify-between border-white/[0.08] border-b pb-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-glow shadow-[0_0_10px] shadow-glow/60"
          />
          <span className="font-mono text-[11px] text-white/50 uppercase tracking-wide">
            Journey runtime
          </span>
        </div>
        <span className="font-mono text-[11px] text-white/40 uppercase tracking-wide">
          Live
        </span>
      </div>

      {/* message thread */}
      <ul className="flex min-h-[260px] flex-col gap-3.5" aria-live="polite">
        {messages.map((message, index) => {
          const shown = index < visible;
          const isAgent = message.from === "agent";

          return (
            <motion.li
              // The messages array is fixed for the lifetime of the loop — we
              // only toggle which entries are visible — so the index is a stable
              // key. (Message text may repeat, so text is not a safe key.)
              // biome-ignore lint/suspicious/noArrayIndexKey: stable, never reordered
              key={index}
              initial={false}
              animate={
                shown
                  ? { opacity: 1, y: 0, filter: "blur(0px)" }
                  : { opacity: 0, y: 12, filter: "blur(4px)" }
              }
              transition={{ duration: 0.45, ease: "easeOut" }}
              className={cn(
                "flex items-end gap-2.5",
                isAgent ? "justify-start" : "flex-row-reverse",
              )}
            >
              {isAgent ? (
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-[6px] bg-glow font-display text-[13px] text-ink"
                >
                  H
                </span>
              ) : null}

              <div
                className={cn(
                  "max-w-[80%] rounded-[10px] px-3.5 py-2.5 text-[13px] leading-relaxed",
                  isAgent
                    ? "border border-white/[0.08] bg-white/[0.04] text-white/80"
                    : "bg-dawn text-ink",
                )}
              >
                {message.text}
              </div>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
