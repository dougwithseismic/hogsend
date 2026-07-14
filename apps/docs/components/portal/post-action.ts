/**
 * Shared POST wire for the portal's action islands (sign, cancel/resume,
 * confirm-card). Returns `{ ok, status }` instead of throwing so each island
 * maps verdict statuses to its own copy; a network failure reads as status 0.
 */
export const ACTION_FAILED = "That didn't take — try again in a moment.";

export async function postPortalAction(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
