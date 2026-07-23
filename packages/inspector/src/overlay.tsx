import { useCallback, useEffect, useRef, useState } from "react";
import { inspectorClickIntent } from "./class-edit.js";
import { ClassEditor, type ClassEditSession } from "./class-editor.js";

/**
 * InspectorOverlay — the runtime half of the inspector (dev only).
 *
 * Hold Option/Alt to "arm" inspect mode: the element under the cursor that
 * carries a build-time `data-hs-source` stamp is highlighted with its source
 * location. Then:
 *   - click            → edit its text in place; Enter writes it back to source,
 *                        Esc cancels.
 *   - cmd/ctrl-click   → edit a direct static Tailwind className.
 *   - shift-click      → open that file at the exact line in your editor.
 *
 * Editing is deterministic: on save the overlay sends the element's source
 * position plus its per-run text (a run = a text node between elements like
 * `<br/>`), and the server replaces those exact runs by AST range. If the edit
 * restructured the element (a run was deleted/merged), it aborts rather than
 * guess. Inert unless armed; relies on stamps that only exist in dev.
 */

const ATTR = "data-hs-source";

export type InspectorOverlayProps = {
  /** POST endpoint that opens a file in the editor. Default /api/devtools/open. */
  openEndpoint?: string;
  /** POST endpoint that writes an edit back to source. Default /api/devtools/edit. */
  editEndpoint?: string;
  /** POST endpoint that reads/writes static className values. Default /api/devtools/style. */
  styleEndpoint?: string;
};

type Stamp = { file: string; line: number; col: number };
type Resolved = { el: HTMLElement; candidates: Stamp[] };
type Hit = { rect: DOMRect; candidates: Stamp[] };
type Editing = {
  el: HTMLElement;
  candidates: Stamp[];
  originalRuns: string[];
  structure: string[];
};

function parseStamp(raw: string): Stamp | null {
  const m = raw.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  const [, file, line, col] = m;
  if (file === undefined || line === undefined || col === undefined)
    return null;
  return { file, line: Number(line), col: Number(col) };
}

/** The React fiber attached to a DOM node (React 17+ internal key). */
// biome-ignore lint/suspicious/noExplicitAny: fiber internals are untyped.
function getFiber(node: Element): any {
  for (const key in node) {
    if (
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$")
    ) {
      return (node as unknown as Record<string, unknown>)[key];
    }
  }
  return null;
}

/**
 * Resolve the clicked/hovered element to its edit target + a list of candidate
 * source positions, NEAREST FIRST. We walk the React FIBER tree (not just the
 * DOM), so a `data-hs-source` stamp that lives only as a prop on a custom
 * component — never forwarded to the DOM — is still found. The server picks the
 * candidate whose source element actually owns the clicked text.
 */
function resolve(target: Element): Resolved | null {
  const el = target as HTMLElement;
  const seen = new Set<string>();
  const candidates: Stamp[] = [];
  let fiber = getFiber(el);
  while (fiber) {
    const props = fiber.memoizedProps ?? fiber.pendingProps;
    const raw = props && typeof props === "object" ? props[ATTR] : null;
    if (typeof raw === "string" && !seen.has(raw)) {
      seen.add(raw);
      const stamp = parseStamp(raw);
      if (stamp) candidates.push(stamp);
    }
    fiber = fiber.return;
  }
  return candidates.length ? { el, candidates } : null;
}

/**
 * A DOM element's direct children as (a) the non-empty text RUNS in order and
 * (b) a STRUCTURE signature (text vs which element) used to detect whether an
 * edit changed the shape. Non-empty text runs line up 1:1 with the element's
 * non-whitespace JSXText children in source.
 */
function directRuns(el: HTMLElement): { runs: string[]; structure: string[] } {
  const runs: string[] = [];
  const structure: string[] = [];
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? "").trim();
      if (t !== "") {
        structure.push("T");
        runs.push(t);
      }
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      structure.push(`E:${(n as Element).tagName}`);
    }
  });
  return { runs, structure };
}

export function InspectorOverlay({
  openEndpoint,
  editEndpoint,
  styleEndpoint,
}: InspectorOverlayProps = {}) {
  const openUrl = openEndpoint ?? "/api/devtools/open";
  const editUrl = editEndpoint ?? "/api/devtools/edit";
  const styleUrl = styleEndpoint ?? "/api/devtools/style";

  const [armed, setArmed] = useState(false);
  const [hit, setHit] = useState<Hit | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [classEditing, setClassEditing] = useState<ClassEditSession | null>(
    null,
  );
  const [status, setStatus] = useState<string | null>(null);
  const activeRef = useRef(false);
  activeRef.current = Boolean(editing || classEditing);

  const disarm = useCallback(() => {
    if (activeRef.current) return;
    setArmed(false);
    setHit(null);
  }, []);

  useEffect(() => {
    const api = {
      arm: () => setArmed(true),
      disarm: () => {
        setArmed(false);
        setHit(null);
      },
      toggle: () => setArmed((a) => !a),
    };
    (window as unknown as { __hsInspector?: typeof api }).__hsInspector = api;
    return () => {
      (window as unknown as { __hsInspector?: typeof api }).__hsInspector =
        undefined;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !activeRef.current) setArmed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") disarm();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", disarm);
    };
  }, [disarm]);

  const openInEditor = useCallback(
    (s: Stamp) => {
      void fetch(openUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s),
      }).catch(() => {});
    },
    [openUrl],
  );

  const beginEdit = useCallback((el: HTMLElement, candidates: Stamp[]) => {
    const { runs, structure } = directRuns(el);
    el.setAttribute("contenteditable", "true");
    el.style.outline = "2px solid #38bdf8";
    el.style.borderRadius = "2px";
    el.focus();
    // A single run → select it all (quick retype). Multiple runs (a headline
    // split by <br/>) → leave the caret where they clicked, edit line by line.
    if (runs.length === 1) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setHit(null);
    setEditing({ el, candidates, originalRuns: runs, structure });
  }, []);

  const beginClassEdit = useCallback((el: HTMLElement, target: Stamp) => {
    setHit(null);
    setClassEditing({ el, target });
  }, []);

  const finishClassEdit = useCallback((message?: string) => {
    setClassEditing(null);
    setArmed(false);
    setHit(null);
    if (!message) {
      setStatus(null);
      return;
    }
    setStatus(message);
    setTimeout(() => setStatus(null), 2600);
  }, []);

  const finishEdit = useCallback((ed: Editing) => {
    ed.el.removeAttribute("contenteditable");
    ed.el.style.outline = "";
    ed.el.style.borderRadius = "";
    setEditing(null);
  }, []);

  const restore = useCallback((ed: Editing) => {
    // Rebuild original text runs in place — but ONLY if the node structure is
    // still what we captured. contentEditable can split/merge text nodes (e.g.
    // an accidental newline), and index-mapping a misaligned set would scramble
    // the text. If it drifted, leave the DOM be — the next render/HMR restores
    // it from source.
    const { structure } = directRuns(ed.el);
    if (JSON.stringify(structure) !== JSON.stringify(ed.structure)) return;
    let i = 0;
    ed.el.childNodes.forEach((n) => {
      if (
        n.nodeType === Node.TEXT_NODE &&
        (n.textContent ?? "").trim() !== ""
      ) {
        n.textContent = ed.originalRuns[i] ?? n.textContent;
        i++;
      }
    });
  }, []);

  const cancelEdit = useCallback(
    (ed: Editing) => {
      restore(ed);
      finishEdit(ed);
      setStatus(null);
    },
    [restore, finishEdit],
  );

  const commitEdit = useCallback(
    async (ed: Editing) => {
      const { runs, structure } = directRuns(ed.el);
      if (JSON.stringify(structure) !== JSON.stringify(ed.structure)) {
        restore(ed);
        finishEdit(ed);
        setStatus("structure changed — edit text only (Esc)");
        setTimeout(() => setStatus(null), 2600);
        return;
      }
      const edits = runs
        .map((newText, index) => ({
          index,
          expectedOld: ed.originalRuns[index],
          newText,
        }))
        .filter((e) => e.newText !== e.expectedOld);

      finishEdit(ed);
      if (!edits.length) return;
      setStatus("saving…");
      try {
        const res = await fetch(editUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidates: ed.candidates, edits }),
        });
        const data = await res.json();
        setStatus(
          data.ok
            ? `saved → ${data.file ?? ""}`
            : `couldn't save (${data.reason ?? "?"})`,
        );
      } catch {
        setStatus("save failed");
      }
      setTimeout(() => setStatus(null), 2600);
    },
    [editUrl, restore, finishEdit],
  );

  useEffect(() => {
    if (!armed || editing || classEditing) return;
    const onMove = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const found = el ? resolve(el) : null;
      setHit(
        found
          ? {
              rect: found.el.getBoundingClientRect(),
              candidates: found.candidates,
            }
          : null,
      );
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const found = el ? resolve(el) : null;
      const first = found?.candidates[0];
      if (!found || !first) return;
      e.preventDefault();
      e.stopPropagation();
      const intent = inspectorClickIntent(e);
      if (intent === "open") openInEditor(first);
      else if (intent === "class") beginClassEdit(found.el, first);
      else beginEdit(found.el, found.candidates);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [armed, editing, classEditing, beginEdit, beginClassEdit, openInEditor]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void commitEdit(editing);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit(editing);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, commitEdit, cancelEdit]);

  return (
    <>
      {armed && hit && !editing && !classEditing ? (
        <Highlight hit={hit} />
      ) : null}
      {editing ? (
        <Badge
          text={`editing ${editing.candidates[0]?.file ?? ""} · ⏎ save · esc cancel`}
        />
      ) : null}
      {classEditing ? (
        <ClassEditor
          key={`${classEditing.target.file}:${classEditing.target.line}:${classEditing.target.col}`}
          el={classEditing.el}
          target={classEditing.target}
          endpoint={styleUrl}
          onClose={finishClassEdit}
        />
      ) : null}
      {status ? <Badge text={status} tone="status" /> : null}
    </>
  );
}

function Highlight({ hit }: { hit: Hit }) {
  const { rect } = hit;
  const first = hit.candidates[0];
  return (
    <>
      <div
        aria-hidden
        style={{
          position: "fixed",
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          background: "rgba(56,189,248,0.14)",
          outline: "1px solid rgba(56,189,248,0.9)",
          borderRadius: 2,
          zIndex: 2147483646,
          pointerEvents: "none",
        }}
      />
      <Badge
        text={`${first ? `${first.file}:${first.line}` : "?"} · click text · ⌘/ctrl click classes · ⇧ open`}
        top={Math.max(2, rect.top - 22)}
        left={rect.left}
      />
    </>
  );
}

function Badge({
  text,
  top,
  left,
  tone,
}: {
  text: string;
  top?: number;
  left?: number;
  tone?: "status";
}) {
  const fixed = top === undefined;
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: fixed ? undefined : top,
        left: fixed ? undefined : left,
        bottom: fixed ? 12 : undefined,
        right: fixed ? 12 : undefined,
        zIndex: 2147483647,
        maxWidth: "90vw",
        padding: "3px 8px",
        font: "500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#0b1220",
        background: tone === "status" ? "#a7f3d0" : "#38bdf8",
        borderRadius: 3,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        pointerEvents: "none",
      }}
    >
      {text}
    </div>
  );
}
