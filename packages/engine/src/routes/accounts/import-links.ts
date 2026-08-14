import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { linkAccount } from "../../lib/account-links.js";
import { noteLinked } from "./emit.js";
import { resolveAccountsContactId } from "./resolve.js";

/**
 * `POST /v1/accounts/import` — THE ONE CARVE-OUT, AND IT IS INSERT-ONLY
 * (DECISIONS §6.2).
 *
 * A customer arriving with years of existing Steam/Twitch links needs them in
 * the store without asking every player to re-authorize. That is the whole
 * scope of this route. It may NOT move a link: **only a completed hosted
 * callback may displace a live owner** (DECISIONS §6.1), because only the
 * callback carries proof of control of the platform account.
 *
 * The insert-only property is STRUCTURAL, not a policy this route enforces in
 * application code: it passes `allowDisplaceLiveOwner: false`, and the store
 * refuses inside its advisory-locked transaction, one statement after the
 * live-owner probe. There is deliberately no read-then-write here — a check in
 * this file would leave a window in which a concurrent hosted callback slips a
 * live owner in between the check and the write.
 *
 * `onConflict` is pinned to `"reject"` and NEVER read from the provider
 * definition. `replace` is a MOVE, and a `multiple: false` provider configured
 * with it must not become an import-time takeover primitive: the same request
 * that is refused for `steam` must be refused for a provider whose author
 * happened to write `onConflict: "replace"`.
 */

const conflictSchema = z.object({
  provider: z.string(),
  providerUserId: z.string(),
  reason: z.enum(["already_linked", "singleton_conflict", "unknown_contact"]),
  /** Present on `already_linked`: who holds the pair right now. */
  ownerContactId: z.string().optional(),
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["Accounts"],
  summary: "Import existing links (insert-only)",
  description:
    'SECRET API KEY + `accounts` scope. Inserts links a customer already had, stamped `method: "import"`, preserving `linkedAt` when supplied. INSERT-ONLY: a pair that already has a live owner is reported under `conflicts` with the existing row left completely untouched — same contact, same version, same `linkedAt` — because only a completed hosted callback may move a link. Partial success: every non-conflicting row is applied and both counts are returned. Max 1000 rows.',
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            rows: z
              .array(
                z
                  .object({
                    provider: z.string().min(1),
                    providerUserId: z.string().min(1),
                    contactId: z.string().optional(),
                    email: z.string().optional(),
                    username: z.string().optional(),
                    avatarUrl: z.string().optional(),
                    /** ISO; preserves the customer's historical timestamp. */
                    linkedAt: z.string().datetime().optional(),
                  })
                  .refine((r) => Boolean(r.contactId) !== Boolean(r.email), {
                    message: "exactly one of contactId | email is required",
                  }),
              )
              .max(1000),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            inserted: z.number(),
            conflicts: z.array(conflictSchema),
          }),
        },
      },
      description:
        "Both counts — a conflicting batch still applies its clean rows",
    },
  },
});

export function registerAccountsImportRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(importRoute, async (c) => {
    const { accountLinkHooks, accountLinkProviders, db, hatchet, logger } =
      c.get("container");
    const { rows } = c.req.valid("json");

    let inserted = 0;
    const conflicts: z.infer<typeof conflictSchema>[] = [];

    for (const row of rows) {
      const contactId = await resolveAccountsContactId(db, {
        contactId: row.contactId,
        email: row.email,
      });
      if (!contactId) {
        // A referenced contact that does not exist is a CONFLICT, never a
        // minted contact: an import row is a claim about a person the customer
        // says they already have, and inventing one would be the ghost-contact
        // case in its purest form.
        conflicts.push({
          provider: row.provider,
          providerUserId: row.providerUserId,
          reason: "unknown_contact",
        });
        continue;
      }

      // `multiple` comes from the provider definition when it is registered,
      // and falls back to the contract default (`true`) when it is not — a
      // customer may legitimately import history for a provider this deploy no
      // longer has configured.
      const provider = accountLinkProviders.get(row.provider);

      const result = await linkAccount({
        db,
        provider: row.provider,
        identity: {
          providerUserId: row.providerUserId,
          ...(row.username ? { username: row.username } : {}),
          ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
        },
        contactId,
        method: "import",
        multiple: provider?.multiple ?? true,
        // PINNED. See the module docstring: `replace` is a move.
        onConflict: "reject",
        // An import carries no proven grant, so there is nothing to seal.
        storeTokens: false,
        allowDisplaceLiveOwner: false,
        ...(row.linkedAt ? { linkedAt: new Date(row.linkedAt) } : {}),
        // The STORE invokes the post-commit after-link hook (DECISIONS
        // §15.4); this route invokes nothing itself.
        hooks: accountLinkHooks,
        logger,
      });

      if (result.status === "rejected") {
        conflicts.push({
          provider: row.provider,
          providerUserId: row.providerUserId,
          reason:
            result.reason === "singleton_conflict"
              ? "singleton_conflict"
              : "already_linked",
          ...(result.currentOwnerContactId
            ? { ownerContactId: result.currentOwnerContactId }
            : {}),
        });
        continue;
      }

      if (result.status === "unchanged") {
        // The pair is ALREADY owned by this very contact. A conflict-free
        // no-op: nothing transitioned, no version was allocated, so it is
        // neither an insert nor a conflict and nothing is emitted.
        continue;
      }

      inserted++;
      // `noteLinked` is the shared fan-out, so an import announces a link the
      // same way the hosted callback does — including any `replacedSingleton`
      // ending, which the `linked` arm can carry too. (This route cannot
      // produce one today, since `onConflict` is pinned to `"reject"`; sharing
      // the fan-out is what keeps that true if it ever changes.)
      noteLinked({ providerId: row.provider, db, hatchet, logger }, result);
    }

    return c.json({ inserted, conflicts }, 200);
  });
}
