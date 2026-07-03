"use client";

import { useMemo, useState } from "react";
import { useLesson } from "@/components/course/lesson-context";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";
import {
  CALCULATORS,
  type CalcFormat,
  type CalcOutput,
} from "@/lib/calculators";

/**
 * An interactive calculator that turns a chapter's idea into the reader's own
 * numbers — CAC · LTV, the leaky bucket, dunning recovery, PMF, ICE. The math
 * and the plain-language read-out live in a preset (lib/calculators.ts); the
 * MDX picks a `preset` + an `id` (its workbook persistence key) and writes the
 * surrounding "why the number matters" prose. Saved inputs + the computed
 * headline + the read-out sentence land in the reader's workbook via
 * /api/responses (kind "calc"). Signed-out readers can compute freely; the save
 * affordance becomes a sign-in link.
 *
 * `preset` must exist in CALCULATORS; `id` must be unique + stable (it's the key).
 */
export function Calculator({
  preset,
  id,
  title,
}: {
  preset: string;
  id: string;
  title?: string;
}) {
  const spec = CALCULATORS[preset];
  const mounted = useMounted();
  const { data: session, isPending } = useSession();
  const lesson = useLesson();
  const { value: saved, save: persist } = useWorkbookResponse<{
    inputs?: Record<string, number>;
    results?: Record<string, number>;
    summary?: string;
  }>("calc", id, `calc:${id}`);

  const [inputs, setInputs] = useState<Record<string, number>>(() => {
    const base = Object.fromEntries(
      (spec?.inputs ?? []).map((input) => [input.key, input.default]),
    );
    return saved?.inputs ? { ...base, ...saved.inputs } : base;
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    saved?.inputs ? "saved" : "idle",
  );

  // A bad preset name is a content bug — fail loud in dev, render nothing in prod.
  const { results, summary } = useMemo(() => {
    if (!spec) return { results: {} as Record<string, number>, summary: "" };
    const raw = spec.compute(inputs);
    const clean: Record<string, number> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (Number.isFinite(val)) clean[key] = val;
    }
    return { results: clean, summary: spec.readout(inputs, clean) };
  }, [spec, inputs]);

  if (!spec) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`<Calculator>: unknown preset "${preset}"`);
    }
    return null;
  }

  const heading = title ?? spec.title;

  function setInput(key: string, raw: string) {
    const n = Number.parseFloat(raw);
    setStatus("idle");
    setInputs((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : 0 }));
  }

  async function save() {
    setStatus("saving");
    const ok = await persist({ inputs, results, summary });
    setStatus(ok ? "saved" : "error");
  }

  const signInHref = `/sign-in?next=${encodeURIComponent(
    lesson ? `/learn/${lesson.course}/${lesson.lesson}` : "/",
  )}`;

  return (
    <div
      id={`wb-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
        Calculator
      </p>
      <p className="mt-2 font-medium text-base text-white">{heading}</p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {spec.inputs.map((input) => (
          <label key={input.key} className="block">
            <span className="text-sm text-white/70">{input.label}</span>
            <span className="mt-1.5 flex items-center gap-1.5 rounded-md border border-white/[0.12] bg-white/[0.02] px-3 py-2 focus-within:border-white/30">
              {input.prefix ? (
                <span className="text-sm text-white/40">{input.prefix}</span>
              ) : null}
              <input
                type="number"
                inputMode="decimal"
                value={
                  Number.isFinite(inputs[input.key]) ? inputs[input.key] : ""
                }
                min={input.min}
                max={input.max}
                step={input.step ?? "any"}
                onChange={(e) => setInput(input.key, e.target.value)}
                className="w-full bg-transparent text-sm text-white tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
              {input.suffix ? (
                <span className="whitespace-nowrap text-sm text-white/40">
                  {input.suffix}
                </span>
              ) : null}
            </span>
            {input.help ? (
              <span className="mt-1 block text-white/35 text-xs leading-snug">
                {input.help}
              </span>
            ) : null}
          </label>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2.5">
        {spec.outputs.map((output) => (
          <OutputTile
            key={output.key}
            output={output}
            value={results[output.key]}
            results={results}
          />
        ))}
      </div>

      <p className="mt-4 text-sm text-white/70 leading-relaxed">{summary}</p>

      <div className="mt-4 flex items-center gap-3">
        {!mounted || isPending ? null : session ? (
          <>
            <button
              type="button"
              onClick={save}
              disabled={status === "saving"}
              className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
            >
              {status === "saving"
                ? "Saving…"
                : status === "saved"
                  ? "Update in workbook"
                  : "Save to workbook"}
            </button>
            {status === "saved" ? (
              <span className="text-good text-sm">
                ✓ Saved —{" "}
                <a href="/workbook" className="underline">
                  view your workbook
                </a>
              </span>
            ) : null}
            {status === "error" ? (
              <span className="text-accent text-sm">
                Couldn't save — try again.
              </span>
            ) : null}
          </>
        ) : (
          <a href={signInHref} className="text-sm text-white/60 underline">
            Sign in free to save your numbers
          </a>
        )}
      </div>
    </div>
  );
}

function formatValue(value: number | undefined, format: CalcFormat): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  switch (format) {
    case "currency":
      return `$${Math.round(value).toLocaleString("en-US")}`;
    case "percent":
      return `${(Math.round(value * 10) / 10).toLocaleString("en-US")}%`;
    case "x":
      return `${(Math.round(value * 10) / 10).toLocaleString("en-US")}×`;
    case "months":
      return `${Math.round(value * 10) / 10} mo`;
    case "ratio":
      return `${Math.round(value * 100) / 100}`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

function OutputTile({
  output,
  value,
  results,
}: {
  output: CalcOutput;
  value: number | undefined;
  results: Record<string, number>;
}) {
  const isGood =
    value !== undefined && output.good ? output.good(value, results) : false;
  return (
    <div
      className={
        output.primary
          ? "min-w-[9rem] flex-1 rounded-md border border-accent/40 bg-accent-tint px-4 py-3"
          : "min-w-[9rem] flex-1 rounded-md border border-white/[0.1] bg-white/[0.02] px-4 py-3"
      }
    >
      <p className="text-[11px] text-white/45 uppercase tracking-[0.1em]">
        {output.label}
      </p>
      <p
        className={
          isGood
            ? "mt-1 font-display text-good text-xl tabular-nums tracking-[-0.02em]"
            : "mt-1 font-display text-white text-xl tabular-nums tracking-[-0.02em]"
        }
      >
        {formatValue(value, output.format)}
      </p>
    </div>
  );
}
