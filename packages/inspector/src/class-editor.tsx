import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyClassNamePreview,
  canPreviewClassName,
  normalizeClassName,
  restoreClassNamePreview,
} from "./class-edit.js";

type Stamp = { file: string; line: number; col: number };

export type ClassEditSession = {
  el: HTMLElement;
  target: Stamp;
};

type ClassEditorProps = ClassEditSession & {
  endpoint: string;
  onClose: (status?: string) => void;
};

type StyleResponse = {
  ok?: boolean;
  reason?: string;
  className?: string;
  unchanged?: boolean;
};

export function ClassEditor({
  el,
  target,
  endpoint,
  onClose,
}: ClassEditorProps) {
  const [sourceClassName, setSourceClassName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [previewable, setPreviewable] = useState(false);
  const [saving, setSaving] = useState(false);
  const originalDomClass = useRef<string | null>(null);
  const lastPreviewClass = useRef<string | null>(null);
  const keepPreview = useRef(false);
  const mounted = useRef(true);
  const saveInFlight = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const originalOutline = el.style.outline;
    const originalOutlineOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #a855f7";
    el.style.outlineOffset = "2px";

    return () => {
      el.style.outline = originalOutline;
      el.style.outlineOffset = originalOutlineOffset;
      if (keepPreview.current) return;
      restoreClassNamePreview(
        el,
        originalDomClass.current,
        lastPreviewClass.current,
      );
    };
  }, [el]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inspect", target }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as StyleResponse;
        if (!mounted.current) return;
        if (!response.ok || !data.ok || typeof data.className !== "string") {
          onClose(`classes unavailable (${data.reason ?? response.status})`);
          return;
        }
        const currentDomClass = el.getAttribute("class");
        originalDomClass.current = currentDomClass;
        lastPreviewClass.current = null;
        const nextPreviewable = canPreviewClassName(
          data.className,
          currentDomClass,
        );
        setSourceClassName(data.className);
        setDraft(data.className);
        setPreviewable(nextPreviewable);
      })
      .catch((error: unknown) => {
        if (
          mounted.current &&
          (error as { name?: string }).name !== "AbortError"
        ) {
          onClose("couldn't inspect classes");
        }
      });
    return () => controller.abort();
  }, [el, endpoint, onClose, target]);

  useEffect(() => {
    if (sourceClassName !== null) textareaRef.current?.focus();
  }, [sourceClassName]);

  const cancel = useCallback(() => {
    if (!saveInFlight.current) onClose();
  }, [onClose]);

  const updateDraft = useCallback(
    (value: string) => {
      setDraft(value);
      if (previewable) {
        const expectedClassName =
          lastPreviewClass.current ?? originalDomClass.current;
        const previewClass = applyClassNamePreview(
          el,
          value,
          expectedClassName,
        );
        if (previewClass === null) {
          setPreviewable(false);
          return;
        }
        lastPreviewClass.current = previewClass;
      }
    },
    [el, previewable],
  );

  const save = useCallback(async () => {
    if (sourceClassName === null || saveInFlight.current) return;
    const className = normalizeClassName(draft);
    if (className === sourceClassName) {
      onClose();
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "write",
          target,
          expectedClassName: sourceClassName,
          className,
        }),
      });
      const data = (await response.json()) as StyleResponse;
      if (!mounted.current) return;
      if (!response.ok || !data.ok) {
        onClose(`couldn't save classes (${data.reason ?? response.status})`);
        return;
      }
      keepPreview.current = previewable && !data.unchanged;
      onClose(`saved classes → ${target.file}`);
    } catch {
      if (mounted.current) onClose("class save failed");
    } finally {
      saveInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [draft, endpoint, onClose, previewable, sourceClassName, target]);

  return (
    <div
      aria-label="Tailwind class editor"
      aria-modal="true"
      aria-busy={saving}
      role="dialog"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 2147483647,
        width: "min(520px, calc(100vw - 24px))",
        padding: 12,
        color: "#f8fafc",
        background: "rgba(15, 23, 42, 0.98)",
        border: "1px solid rgba(168, 85, 247, 0.8)",
        borderRadius: 8,
        boxShadow: "0 20px 50px rgba(2, 6, 23, 0.4)",
        font: "500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <strong style={{ color: "#d8b4fe", fontSize: 12 }}>
          Tailwind classes
        </strong>
        <span
          title={`${target.file}:${target.line}:${target.col}`}
          style={{
            minWidth: 0,
            color: "#94a3b8",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {target.file}:{target.line}
        </span>
      </div>

      {sourceClassName === null ? (
        <div
          aria-live="polite"
          style={{ padding: "16px 2px", color: "#cbd5e1" }}
        >
          Reading source className…
        </div>
      ) : (
        <>
          <textarea
            aria-label="Tailwind class list"
            ref={textareaRef}
            rows={4}
            spellCheck={false}
            disabled={saving}
            value={draft}
            onChange={(event) => updateDraft(event.currentTarget.value)}
            style={{
              boxSizing: "border-box",
              display: "block",
              width: "100%",
              resize: "vertical",
              padding: "9px 10px",
              color: "#f8fafc",
              background: "#020617",
              border: "1px solid #475569",
              borderRadius: 5,
              outline: "none",
              font: "500 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          />
          <div
            style={{
              marginTop: 7,
              color: previewable ? "#86efac" : "#fbbf24",
              fontSize: 10,
            }}
          >
            {previewable
              ? "Live preview is on. New Tailwind utilities appear after save + HMR."
              : "Runtime classes are merged here; the visual update appears after save + HMR."}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 7,
              marginTop: 10,
            }}
          >
            <button
              type="button"
              disabled={saving}
              onClick={cancel}
              style={buttonStyle("secondary", saving)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              style={buttonStyle("primary", saving)}
            >
              {saving ? "Saving…" : "Save · ⌘/Ctrl ↵"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function buttonStyle(
  tone: "primary" | "secondary",
  disabled = false,
): React.CSSProperties {
  return {
    appearance: "none",
    padding: "5px 9px",
    color: tone === "primary" ? "#1e1b4b" : "#e2e8f0",
    background: tone === "primary" ? "#c4b5fd" : "#334155",
    border: 0,
    borderRadius: 4,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.7 : 1,
    font: "600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
  };
}
