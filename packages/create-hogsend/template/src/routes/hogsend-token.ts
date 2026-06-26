import type { RoutesFn } from "@hogsend/engine";
import { generateUserToken } from "@hogsend/engine";

/**
 * REFERENCE EXAMPLE — mint a short-lived Hogsend `userToken` for a logged-in
 * browser. COPY + ADAPT THIS; do not ship it as-is.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why this route exists
 * ───────────────────────────────────────────────────────────────────────────
 * A `pk_` publishable key (the one your browser ships) is ANONYMOUS-ONLY by
 * design. The engine refuses to let a browser assert it *is* a concrete user
 * unless the request carries a `userToken` — a short-lived HMAC over
 * `{ userId, exp }` signed with `BETTER_AUTH_SECRET`. The token is signed, not
 * encrypted: it proves integrity (a browser can't forge another person's
 * `userId`) and carries no PII. `@hogsend/react`'s `<HogsendProvider userToken>`
 * sends it in the body of identity-asserting calls; the engine verifies it.
 *
 * Minting is the only half the engine does NOT expose as a built-in route — on
 * purpose, because minting requires the signing secret and must happen behind
 * YOUR OWN login. This file is that missing half, as a reference.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️  THE ONE THING YOU MUST CHANGE
 * ───────────────────────────────────────────────────────────────────────────
 * `resolveAuthenticatedUserId()` below is a STUB that always returns
 * `undefined`, so this route is INERT until you wire it up — it 401s every
 * request rather than minting a token for an attacker-chosen id.
 *
 * Replace it with YOUR end-user auth. This scaffold ships ADMIN/session auth
 * only (better-auth at `/api/auth/*`); it has NO end-user session. So derive the
 * authenticated user's id from your own login — your session cookie, Clerk,
 * Supabase, NextAuth, a JWT, etc. — and ONLY THEN mint.
 *
 * NEVER read the `userId` straight from the request body and mint for it. That
 * lets anyone assert any identity and defeats the entire integrity guarantee.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Email + cross-channel ids (Discord, etc.) are folded SERVER-SIDE
 * ───────────────────────────────────────────────────────────────────────────
 * A `userToken` binds a `userId` and NOTHING ELSE — the engine 403s a browser
 * that tries to assert an `email` even with a valid token. To attach an email
 * (or a `discord_id`, etc.) to this contact, use your secret data-plane key
 * from the server:
 *
 *   PUT /v1/contacts   Authorization: Bearer <secret hsk_ key>
 *   { "userId": "user_123", "email": "person@example.com" }
 *
 * See the `hs` client at `src/lib/hogsend.ts` (`hs.contacts.upsert(...)`).
 */

/**
 * STUB — swap in your real end-user auth. Return the authenticated user's id,
 * or `undefined` when the caller isn't logged in. When you wire this up, take
 * the request (the handler's `c.req.raw`) as a param and read your session off
 * it, e.g.:
 *   const session = await getMySession(request); return session?.userId;
 *   const { userId } = await clerkAuth(request);   return userId ?? undefined;
 */
async function resolveAuthenticatedUserId(): Promise<string | undefined> {
  // ⬇️ REPLACE THIS LINE with your own auth lookup. Returning undefined keeps
  //    the route safely inert (it 401s instead of minting).
  return undefined;
}

/**
 * Mounts `POST /v1/example/user-token` after the engine's built-in routes.
 * Wired into `createApp(client, { routes })` in `src/index.ts`.
 *
 * The path is namespaced under `/v1/example/` so it reads as a sample, not a
 * stable engine route — rename it to whatever your frontend calls.
 */
export const hogsendTokenRoutes: RoutesFn = (app) => {
  app.post("/v1/example/user-token", async (c) => {
    // The DI container holds the same validated `BETTER_AUTH_SECRET` the engine
    // verifies tokens with — the single shared trust root. (You could also read
    // `process.env.BETTER_AUTH_SECRET!`, but `client.env` is already typed.)
    const { env } = c.get("container");

    // 👇 YOUR AUTH. The stub returns undefined → this route 401s until you wire
    //    it. Do NOT replace this with `(await c.req.json()).userId`.
    const userId = await resolveAuthenticatedUserId();
    if (!userId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const userToken = generateUserToken({
      secret: env.BETTER_AUTH_SECRET,
      userId,
      expiresInSeconds: 3600, // default 3600 (1h)
    });

    // Hand the token to the browser. Your frontend passes it to
    // <HogsendProvider userToken> and re-fetches this route from
    // `onUserTokenExpiring` when it expires.
    return c.json({ userToken });
  });
};
