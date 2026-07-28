/**
 * The one shape every settings server action returns.
 *
 * It lives here rather than in the `"use server"` module because a client
 * component imports the type, and a server-actions file may only export async
 * functions — a type import from it is erased, but a plain module keeps the
 * boundary obvious.
 */
export type ActionState = {
  /** A rule the caller can act on, or null. */
  error: string | null;
  /** One factual line on success. */
  notice?: string | null;
};

export const EMPTY_ACTION_STATE: ActionState = { error: null, notice: null };

/** The `(state, formData) => state` signature `useActionState` binds to. */
export type FormAction = (
  state: ActionState,
  formData: FormData,
) => Promise<ActionState>;
