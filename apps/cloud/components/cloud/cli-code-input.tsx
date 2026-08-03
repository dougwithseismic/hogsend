"use client";

import type { ClipboardEvent, JSX, KeyboardEvent } from "react";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import {
  sanitizeUserCodeInput,
  USER_CODE_LENGTH,
} from "@/src/lib/user-code-input";

/**
 * The eight-box code input on `/cli/approve`.
 *
 * Every box is a REAL `<input>` with its own accessible name, inside a group
 * the page's `<label>` points at — a screen reader hears "Code, character 1 of
 * 8", not a row of anonymous boxes. What the form POSTS is one hidden
 * `userCode` field carrying the joined characters, so the server action reads
 * exactly what the old single field sent and nothing about the contract moves.
 *
 * Every way characters arrive — a keystroke, a paste of `KS66-XZSM`, the
 * `?code=` prefill — goes through `sanitizeUserCodeInput`, so dashes and
 * whitespace vanish, case is folded, and characters the code alphabet excludes
 * never land in a box (the keystroke visibly not taking is the feedback).
 */

const GROUP = 4;
const boxIds = Array.from(
  { length: USER_CODE_LENGTH },
  (_, index) => `cli-user-code-${index}`,
);

export function CliCodeInput({
  initialCode,
}: {
  /** From `?code=` when the CLI opened the browser. Any accepted form. */
  initialCode?: string;
}): JSX.Element {
  const [chars, setChars] = useState<string[]>(() => {
    const seeded = sanitizeUserCodeInput(initialCode ?? "");
    return Array.from(
      { length: USER_CODE_LENGTH },
      (_, index) => seeded[index] ?? "",
    );
  });
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const focusBox = (index: number) => {
    const box =
      refs.current[Math.min(Math.max(index, 0), USER_CODE_LENGTH - 1)];
    box?.focus();
    box?.select();
  };

  /** Write a run of sanitized characters starting at `start`. */
  const writeFrom = (start: number, incoming: string) => {
    const clean = sanitizeUserCodeInput(incoming);
    setChars((previous) => {
      const next = [...previous];
      for (
        let at = 0;
        at < clean.length && start + at < USER_CODE_LENGTH;
        at += 1
      ) {
        next[start + at] = clean[at] as string;
      }
      return next;
    });
    if (clean.length > 0) focusBox(start + clean.length);
  };

  const onChange = (index: number, value: string) => {
    if (value === "") {
      setChars((previous) => {
        const next = [...previous];
        next[index] = "";
        return next;
      });
      return;
    }
    writeFrom(index, value);
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      // An empty box backspaces INTO the previous one — one keystroke per
      // wrong character, like every OTP input a human has already learnt.
      if (chars[index] === "" && index > 0) {
        event.preventDefault();
        setChars((previous) => {
          const next = [...previous];
          next[index - 1] = "";
          return next;
        });
        focusBox(index - 1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusBox(index - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const clean = sanitizeUserCodeInput(event.clipboardData.getData("text"));
    // A whole code replaces everything regardless of which box was focused —
    // pasting is always "here is the code", never "insert at the caret".
    writeFrom(clean.length === USER_CODE_LENGTH ? 0 : index, clean);
  };

  return (
    <fieldset
      aria-label="Code from the terminal, 8 characters"
      className="flex flex-wrap items-center gap-2"
    >
      {chars.map((char, index) => (
        <span key={boxIds[index]} className="flex items-center gap-2">
          {/* The visual dash between the two groups of four — display
              punctuation only, so assistive tech skips it. */}
          {index === GROUP ? (
            <span aria-hidden className="text-white/30">
              –
            </span>
          ) : null}
          <input
            ref={(element) => {
              refs.current[index] = element;
            }}
            id={boxIds[index]}
            aria-label={`Code character ${index + 1} of ${USER_CODE_LENGTH}`}
            value={char}
            onChange={(event) => onChange(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
            onFocus={(event) => event.target.select()}
            autoComplete={index === 0 ? "one-time-code" : "off"}
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            className={cn(
              "h-12 w-10 rounded-[10px] border border-white/15 bg-white/[0.03]",
              "text-center font-mono text-base text-white",
              "transition-colors duration-200 outline-none",
              "focus:border-accent focus:bg-white/[0.05]",
            )}
          />
        </span>
      ))}
      {/* What the server action reads — the same `userCode` the single field
          posted before the boxes existed. */}
      <input type="hidden" name="userCode" value={chars.join("")} />
    </fieldset>
  );
}
