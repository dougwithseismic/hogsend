"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useLesson } from "@/components/course/lesson-context";
import { type ResponseKind, saveResponse } from "@/components/course/responses";
import type { SavedValue } from "@/lib/workbook";

/**
 * The reader's saved answers for the current page, shared across every
 * interactive block AND the chapter surfaces (workbook callout, recap). The
 * lesson page server-loads the signed-in reader's response rows and feeds them
 * here, so blocks render their saved state in the SSR HTML (no fetch flash);
 * when a block saves, it writes back into this store and the callout/recap
 * tick over live. Blocks are only ever rendered inside a provider (the lesson
 * body is always wrapped) — there is no client-fetch fallback.
 */

type WorkbookState = {
  values: Record<string, SavedValue>;
  set: (key: string, value: SavedValue) => void;
};

const WorkbookStateContext = createContext<WorkbookState | null>(null);

export function WorkbookStateProvider({
  initial,
  children,
}: {
  initial: Record<string, SavedValue>;
  children: ReactNode;
}) {
  const [values, setValues] = useState(initial);
  const set = useCallback((key: string, value: SavedValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);
  const state = useMemo(() => ({ values, set }), [values, set]);
  return (
    <WorkbookStateContext.Provider value={state}>
      {children}
    </WorkbookStateContext.Provider>
  );
}

/** Live map of saved answers (null outside a provider). */
export function useWorkbookValues(): Record<string, SavedValue> | null {
  return useContext(WorkbookStateContext)?.values ?? null;
}

/**
 * One block's saved answer + a persist function. The value is served from the
 * provider store (server-fed, so it's present on first render). `save` hits
 * /api/responses and, on success, updates the shared store so every surface
 * reflects it immediately.
 */
export function useWorkbookResponse<T extends SavedValue>(
  kind: ResponseKind,
  id: string,
  key: string,
): { value: T | null; save: (next: T) => Promise<boolean> } {
  const ctx = useContext(WorkbookStateContext);
  const lesson = useLesson();

  const value = (ctx?.values[key] as T | undefined) ?? null;

  const save = useCallback(
    async (next: T): Promise<boolean> => {
      const ok = await saveResponse(kind, id, next, lesson);
      if (ok) ctx?.set(key, next);
      return ok;
    },
    [ctx, kind, id, key, lesson],
  );

  return { value, save };
}
