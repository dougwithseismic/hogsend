"use client";

import { Copy, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AgentPromptLoop } from "@/app/(landing)/_components/agent-prompt-loop";
import { PROMPT_SCENARIOS } from "@/app/(landing)/_components/agent-prompt-loop-state";
import { cn } from "@/lib/cn";
import { EmailPane } from "./email-preview";
import {
  fileFor,
  MINTED_FILES,
  SCENARIO_SURFACES,
  sourceFor,
} from "./minted-files";
import { SurfacePane } from "./surface-preview";
import { WindowFrame } from "./window-frame";

/* ==========================================================================
 *  SPIKE — the hero's window stage.
 *
 *  The docked window holds the CLI replay. Every file the run writes gets its
 *  own floating window, minted at the moment the terminal prints the
 *  `+ path` line — journeys open as source, emails open as a rendered
 *  preview. Write lines in the feed are clickable, so a reader can reopen any
 *  file the run has already produced.
 *
 *  Windows are keyed by PATH, not by scenario: one run writes two or three
 *  files and they are separate objects on the desk.
 * ========================================================================== */

const ACCENT = "#f64838";
const TEAR_THRESHOLD = 48;
const WINDOW_WIDTH = 420;

type Popped = {
  wid: string;
  path: string;
  x: number;
  y: number;
  /** minted by the run rather than opened by the reader — these are cleared
   *  when the next example starts so windows do not pile up across the loop */
  auto?: boolean;
};

/** Floating windows are a desktop affordance: there is nowhere to put them on
 *  a phone, and dragging them fights the page scroll. Below the breakpoint the
 *  hero degrades to the docked window alone — the file is still reachable
 *  through its tab, so nothing becomes unreachable. Matches the `xl:` split. */
function useWindowingEnabled() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const sync = () => setEnabled(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return enabled;
}

function scenarioFor(id: string) {
  return PROMPT_SCENARIOS.find((s) => s.id === id) ?? PROMPT_SCENARIOS[0];
}

/** Mirror the shared component's active scenario without forking it. */
function useMintedScenarioId(rootRef: React.RefObject<HTMLDivElement | null>) {
  const [id, setId] = useState(PROMPT_SCENARIOS[0].id);

  useEffect(() => {
    const el = rootRef.current?.querySelector("[data-prompt-id]");
    if (!el) return;

    const sync = () =>
      setId(el.getAttribute("data-prompt-id") ?? PROMPT_SCENARIOS[0].id);

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, {
      attributes: true,
      attributeFilter: ["data-prompt-id"],
    });
    return () => observer.disconnect();
  }, [rootRef]);

  return id;
}

/** Keep the feed following its tail, but stop the component's per-character
 *  scrollTo from overruling a reader who has scrolled back. */
function usePinnedFeed(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      "[data-animated-prompt]",
    );
    if (!viewport) return;

    const NEAR_TAIL = 48;
    let pinned = true;

    const trackIntent = () => {
      pinned =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
        NEAR_TAIL;
    };
    const pin = () => {
      if (pinned) viewport.scrollTop = viewport.scrollHeight;
    };

    const followTail = viewport.scrollTo.bind(viewport);
    viewport.scrollTo = ((...args: Parameters<Element["scrollTo"]>) => {
      if (pinned) followTail(...args);
    }) as Element["scrollTo"];

    viewport.addEventListener("scroll", trackIntent, { passive: true });
    const content = new MutationObserver(pin);
    content.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const box = new ResizeObserver(pin);
    box.observe(viewport);
    pin();

    return () => {
      viewport.scrollTo = followTail;
      viewport.removeEventListener("scroll", trackIntent);
      content.disconnect();
      box.disconnect();
    };
  }, [rootRef]);
}

/* -------------------------------------------------------------------------- */

export function SessionStage({
  engineVersion,
  highlighted,
  className,
}: {
  engineVersion?: string;
  highlighted: Record<string, ReactNode>;
  className?: string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const cliRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"cli" | "file">("cli");
  const [popped, setPopped] = useState<Popped[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const windowing = useWindowingEnabled();
  const scenarioId = useMintedScenarioId(cliRef);
  const scenario = scenarioFor(scenarioId);
  usePinnedFeed(cliRef);

  // shrinking past the breakpoint puts the windows away rather than stranding
  // them off-screen
  useEffect(() => {
    if (!windowing) setPopped([]);
  }, [windowing]);

  // the mint observer is armed once; read the live scenario through a ref so
  // it does not need re-arming (which would replay every existing write row)
  const scenarioIdRef = useRef(scenarioId);
  scenarioIdRef.current = scenarioId;

  useEffect(() => setMounted(true), []);

  /** Park a window just off the terminal's right edge, so the two sit side by
   *  side with only a sliver of overlap, clamped into the viewport. */
  const restingPlace = useCallback((index = 0) => {
    const stage = stageRef.current?.getBoundingClientRect();
    // Cascade DOWN and LEFT, not down-and-right: the first window already sits
    // against the right edge, so a rightward offset gets clamped away and the
    // stack lands on top of itself.
    const preferred = (stage ? stage.right : 0) - 36 - index * 44;
    return {
      x: Math.min(
        Math.max(16, preferred),
        Math.max(16, window.innerWidth - WINDOW_WIDTH - 16),
      ),
      y: Math.max(16, (stage ? stage.top : 120) + 48 + index * 62),
    };
  }, []);

  /** Explicit open — clicking a write line, or tearing the tab off. */
  const openFile = useCallback(
    (path: string, at?: { x: number; y: number }) => {
      if (!fileFor(path)) return;
      setPopped((open) => {
        const existing = open.find((w) => w.path === path);
        if (existing) {
          setFocused(existing.wid);
          return open;
        }
        const wid = `w-${path}`;
        setFocused(wid);
        return [...open, { wid, path, ...(at ?? restingPlace(open.length)) }];
      });
    },
    [restingPlace],
  );

  const close = useCallback((wid: string) => {
    setPopped((open) => open.filter((w) => w.wid !== wid));
  }, []);

  /* ---- mint a window the instant the terminal writes each file ---- */
  useEffect(() => {
    if (!windowing) return;
    const viewport = cliRef.current?.querySelector<HTMLElement>(
      "[data-animated-prompt]",
    );
    if (!viewport) return;

    // Each output row renders as glyph + text, and a write row's glyph is "+".
    // Reading that from the DOM means the mint is driven by what the terminal
    // actually printed, with no fork of the shared component.
    const readWrites = () => {
      const current = viewport.firstElementChild?.lastElementChild;
      if (!current) return;

      const written = [...current.querySelectorAll("p")]
        .filter((row) => row.firstElementChild?.textContent?.trim() === "+")
        .map((row) => row.lastElementChild?.textContent?.trim() ?? "")
        .filter((path) => MINTED_FILES[path]);
      if (!written.length) return;

      // One window PER written file. A run that writes a journey and an email
      // ends up with both on the desk — reusing a single slot would just make
      // one window flip between them.
      setPopped((open) => {
        const fresh = written.filter(
          (path) => !open.some((w) => w.path === path),
        );
        if (!fresh.length) return open;

        return [
          ...open,
          ...fresh.map((path, i) => ({
            wid: `auto-${path}`,
            path,
            auto: true,
            ...restingPlace(open.length + i),
          })),
        ];
      });
    };

    // The closing "✓ journey registered" row means the run is done: that is
    // when the channel surfaces it will send become worth showing.
    const readSurfaces = () => {
      const current = viewport.firstElementChild?.lastElementChild;
      if (!current) return;

      const done = [...current.querySelectorAll("p")].some(
        (row) => row.firstElementChild?.textContent?.trim() === "✓",
      );
      if (!done) return;

      const surfaces = SCENARIO_SURFACES[scenarioIdRef.current] ?? [];
      if (!surfaces.length) return;

      setPopped((open) => {
        const fresh = surfaces.filter(
          (path) => !open.some((w) => w.path === path),
        );
        if (!fresh.length) return open;

        return [
          ...open,
          ...fresh.map((path, i) => ({
            wid: `auto-${path}`,
            path,
            auto: true,
            ...restingPlace(open.length + i),
          })),
        ];
      });
    };

    const tick = () => {
      readWrites();
      readSurfaces();
    };

    tick();
    const observer = new MutationObserver(tick);
    observer.observe(viewport, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [restingPlace, windowing]);

  /* ---- clicking a written file in the feed opens it ---- */
  useEffect(() => {
    if (!windowing) return;
    const viewport = cliRef.current?.querySelector<HTMLElement>(
      "[data-animated-prompt]",
    );
    if (!viewport) return;

    const onClick = (event: MouseEvent) => {
      const row = (event.target as HTMLElement).closest("p");
      if (!row || row.firstElementChild?.textContent?.trim() !== "+") return;
      const path = row.lastElementChild?.textContent?.trim();
      if (path) openFile(path);
    };

    viewport.addEventListener("click", onClick);
    return () => viewport.removeEventListener("click", onClick);
  }, [openFile, windowing]);

  /* ---- a new example clears the run's windows and starts at the top ---- */
  // scenarioId is the TRIGGER for this effect, not a value it reads: a new
  // example is exactly when the previous run's windows should clear.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger dep
  useEffect(() => {
    // only the ones the run minted; anything the reader opened is theirs
    setPopped((open) => open.filter((w) => !w.auto));

    const viewport = cliRef.current?.querySelector<HTMLElement>(
      "[data-animated-prompt]",
    );
    const current = viewport?.firstElementChild?.lastElementChild;
    if (!viewport || !current) return;

    viewport.scrollTop +=
      current.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      12;
  }, [scenarioId]);

  const stepPrompt = useCallback((direction: -1 | 1) => {
    const selector =
      direction === 1 ? "[data-prompt-next]" : "[data-prompt-previous]";
    cliRef.current?.querySelector<HTMLButtonElement>(selector)?.click();
  }, []);

  return (
    <div ref={stageRef} className={cn("relative", className)}>
      <WindowFrame
        size={{ height: 420 }}
        minSize={{ width: 360, height: 240 }}
        className="w-full"
        onFocus={() => setFocused(null)}
        elevated={focused === null}
        handle={
          <div className="flex items-stretch border-white/[0.08] border-b">
            <TabButton active={tab === "cli"} onClick={() => setTab("cli")}>
              <BoarMark />
              CLI
            </TabButton>

            <TearableTab
              active={tab === "file"}
              label={scenario.file}
              onSelect={() => setTab("file")}
              onTear={(at) => openFile(scenario.file, at)}
            />

            <span className="ml-auto flex shrink-0 items-center gap-3 px-4 font-mono text-[11px]">
              {engineVersion ? (
                <span className="hidden text-white/35 xl:inline">
                  engine <span className="text-white/60">v{engineVersion}</span>
                </span>
              ) : null}
              <span className="flex items-center gap-1.5 text-[#23c489]">
                <span className="size-1.5 rounded-full bg-[#23c489]" />
                Deployed
              </span>
            </span>
          </div>
        }
      >
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <div
              ref={cliRef}
              className={cn("h-full", tab !== "cli" && "hidden")}
            >
              <div
                className={cn(
                  "h-full",
                  "[&_[data-prompt-surface]]:!flex [&_[data-prompt-surface]]:!h-full [&_[data-prompt-surface]]:!flex-col [&_[data-prompt-surface]]:!rounded-none [&_[data-prompt-surface]]:!border-0 [&_[data-prompt-surface]]:!bg-transparent [&_[data-prompt-surface]]:!shadow-none",
                  "[&_[data-prompt-surface]>div:first-of-type]:hidden",
                  "[&_[data-prompt-surface]>div:last-of-type]:hidden",
                  // the scrollport only scrolls if its wrapper is a bounded
                  // flex child — h-full alone resolves against an auto-height
                  // parent and the feed just overflows instead
                  "[&_[data-prompt-surface]>div:nth-of-type(2)]:min-h-0 [&_[data-prompt-surface]>div:nth-of-type(2)]:flex-1",
                  "[&_[data-animated-prompt]]:!h-full [&_[data-animated-prompt]]:[scrollbar-width:thin]",
                )}
              >
                <AgentPromptLoop />
              </div>
            </div>

            <div className={cn("h-full", tab !== "file" && "hidden")}>
              <CodePane node={highlighted[scenario.file]} />
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-white/[0.08] border-t px-4 py-2.5">
            <div className="flex items-center gap-2">
              <StepButton
                label="Previous prompt"
                onClick={() => stepPrompt(-1)}
              >
                ←
              </StepButton>
              <StepButton label="Next prompt" onClick={() => stepPrompt(1)}>
                →
              </StepButton>
            </div>
            {windowing ? (
              <span className="truncate font-mono text-[11px] text-white/30">
                click any written file to open it
              </span>
            ) : null}
          </div>
        </div>
      </WindowFrame>

      {/* Portalled to <body>: the hero column is its own stacking context, so
          a window rendered inside it can never rise above the plugin strip. */}
      {mounted && windowing
        ? createPortal(
            <AnimatePresence>
              {popped.map((w) => {
                const file = fileFor(w.path);
                if (!file) return null;
                const isEmail = file.kind === "email";
                const isSurface = file.kind === "surface";

                return (
                  <WindowFrame
                    key={w.wid}
                    size={{
                      width: WINDOW_WIDTH,
                      height: isEmail ? 348 : isSurface ? 280 : 300,
                    }}
                    minSize={{ width: 300, height: 180 }}
                    initialPosition={{ x: w.x, y: w.y }}
                    elevated={focused === w.wid}
                    onFocus={() => setFocused(w.wid)}
                    handle={
                      <div className="flex items-center gap-2 border-white/[0.08] border-b px-4 py-2.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70">
                          {w.path}
                        </span>
                        {isEmail || isSurface ? (
                          <span className="shrink-0 font-mono text-[10px] text-white/35 uppercase tracking-[0.06em]">
                            preview
                          </span>
                        ) : null}
                        {w.auto ? (
                          <span
                            className="shrink-0 font-mono text-[10px] tracking-[0.06em]"
                            style={{ color: ACCENT }}
                            title="Written by this run"
                          >
                            new
                          </span>
                        ) : null}
                        {file.kind === "code" ? (
                          <CopyCode value={sourceFor(w.path)} />
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Close ${w.path}`}
                          onClick={() => close(w.wid)}
                          className="shrink-0 cursor-pointer text-white/40 transition-colors hover:text-white"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    }
                  >
                    {file.kind === "email" ? (
                      <EmailPane email={file.email} />
                    ) : file.kind === "surface" ? (
                      <SurfacePane surface={file.surface} />
                    ) : (
                      <CodePane node={highlighted[w.path]} />
                    )}
                  </WindowFrame>
                );
              })}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CodePane({ node }: { node: ReactNode }) {
  return (
    <div className="h-full overflow-auto px-4 py-3 [scrollbar-width:thin] [&_pre]:!bg-transparent [&_pre]:text-[12.5px] [&_pre]:leading-[1.6]">
      {node ?? null}
    </div>
  );
}

function BoarMark() {
  return (
    <span
      aria-hidden="true"
      className="block h-[9px] w-[15px] bg-current"
      style={{
        WebkitMaskImage: "url(/images/logos/hogsend-boar.svg)",
        maskImage: "url(/images/logos/hogsend-boar.svg)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-2 border-r border-white/[0.08] px-4 py-2.5 font-mono text-[11px] tracking-wide transition-colors",
        active
          ? "bg-white/[0.06] text-white/85"
          : "text-white/40 hover:text-white/70",
      )}
    >
      {children}
    </button>
  );
}

/** A tab you can drag off the rail; a short drag counts as a click. */
function TearableTab({
  active,
  label,
  onSelect,
  onTear,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
  onTear: (at: { x: number; y: number }) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, y: event.clientY };
        setDragging(true);
      }}
      onPointerUp={(event) => {
        setDragging(false);
        const from = origin.current;
        origin.current = null;
        if (!from) return;

        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (Math.hypot(dx, dy) < TEAR_THRESHOLD) {
          onSelect();
          return;
        }
        onTear({
          x: Math.max(8, event.clientX - 120),
          y: Math.max(8, event.clientY - 16),
        });
      }}
      className={cn(
        "flex min-w-0 cursor-grab items-center gap-2 border-r border-white/[0.08] px-4 py-2.5 font-mono text-[11px] tracking-wide transition-colors active:cursor-grabbing",
        active
          ? "bg-white/[0.06] text-white/85"
          : "text-white/40 hover:text-white/70",
        dragging && "bg-white/[0.1]",
      )}
      title="Drag off to open in its own window"
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[6px] border border-white/10 font-mono text-[13px] text-white/40 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

function CopyCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label="Copy source"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 font-mono text-[11px] text-white/40 transition-colors hover:text-white/80"
    >
      <Copy size={12} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
