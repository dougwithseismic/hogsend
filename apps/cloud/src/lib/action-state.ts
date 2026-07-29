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

/**
 * The rotate-publish-token action's state: the ordinary shape plus the ONE copy
 * of the freshly issued secret.
 *
 * It travels in the action's return value and nowhere else — not in a cookie,
 * not in a revalidated page read — because the token is stored hashed and can
 * never be recovered. The form renders it once; a reload shows the card with
 * `last4` and no secret.
 */
export type PublishTokenState = ActionState & {
  /** The new token, or null when the action refused or has not run. */
  token?: string | null;
};

export const EMPTY_PUBLISH_TOKEN_STATE: PublishTokenState = {
  error: null,
  notice: null,
  token: null,
};

export type PublishTokenFormAction = (
  state: PublishTokenState,
  formData: FormData,
) => Promise<PublishTokenState>;
