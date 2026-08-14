import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { Database } from "@hogsend/db";
import {
  type AccountUnlinkedFacts,
  buildAccountUnlinkedPayload,
  buildDedupeKey,
} from "./account-link-events.js";
import { createLogger, type Logger } from "./logger.js";

// The engine singletons, the `lib/preferences.ts` idiom: the `lib/contacts.ts`
// emit sites are reached from library code (the merge, the delete leg) that has
// no request container to read a `hatchet`/`logger` off. A caller that DOES
// have one passes it (see {@link EmitHandles}).
const logger = createLogger(process.env.LOG_LEVEL);

/**
 * The container's handles, when the caller has a container.
 *
 * `logger` attributes the emit to the caller's request. `hatchet` buys exactly
 * one thing — it spares this module the `./hatchet.js` dynamic import below,
 * which is what runs `HatchetClient.init` — plus satisfying `emitOutbound`'s
 * signature. It does NOT redirect delivery, and claiming otherwise would be
 * false: `emitOutbound` destructures
 * `const { db, logger, event, payload, dedupeKey } = opts`
 * (`outbound.ts:619`) and never reads `opts.hatchet`, and the enqueue runs
 * through the MODULE-LEVEL `deliverWebhookTask` built from the singleton at
 * import time, so `opts.overrides.hatchet` cannot reroute it. Both fields are
 * optional so the container-free `lib/contacts.ts` call sites stay a two-arg
 * call.
 */
export type EmitHandles = {
  hatchet?: HatchetClient;
  logger?: Logger;
};

/**
 * Fan out one `account.unlinked` per mutation fact (PRD 08 T3).
 *
 * This exists so the emit SHAPE lives once: `MergedLinkUnlink` (the merge's
 * singleton-collision soft-unlink, `reason: "relinked"`) and
 * `ContactUnlinkFact` (the contact-deletion leg, `reason: "api"`) both satisfy
 * {@link AccountUnlinkedFacts} structurally, so both legs share this loop and
 * cannot drift apart on the payload or the dedupe key.
 *
 * ## Call it AFTER the mutation's transaction has RESOLVED, never inside it
 *
 * DECISIONS §8 puts emission at the commit/intent layer. Both callers hand us
 * facts a `db.transaction(...)` already returned: a rolled-back merge or
 * delete must never have announced an unlink that did not happen, and a
 * subscriber that reacts by re-reading the pull plane inside the write's own
 * transaction window would read pre-commit state.
 *
 * ## Fire-and-forget, and it stays that way
 *
 * `emitOutbound` never throws (`outbound.ts:600-608`); the `void … .catch` is
 * the defence-in-depth its own docstring asks every call site for. A webhook
 * problem must never fail a contact merge or a GDPR deletion, so this function
 * returns `void` rather than a promise — there is deliberately nothing for a
 * caller to await and therefore nothing for a caller to accidentally fail on.
 *
 * `version` is threaded through as the decimal STRING the store produced and
 * is never parsed (DECISIONS §5.1). `userId`/`email` come off `fact.owner`,
 * read inside the mutation's transaction, and are never looked up here.
 *
 * ## The spine is reached by DYNAMIC import, on purpose
 *
 * `lib/contacts.ts` imports this module, and `src/testing.ts` re-exports
 * `softDeleteContact` from `lib/contacts.ts`. A STATIC `./hatchet.js` or
 * `./outbound.js` import here (outbound → `workflows/deliver-webhook.js` →
 * `lib/hatchet.js`) would therefore run `HatchetClient.init(...)` the moment
 * anything touched the `@hogsend/engine/testing` barrel, which is documented
 * side-effect-free and is consumed where no real Hatchet token exists — it
 * throws `Invalid token format` before a single test runs. Resolving both
 * inside the fire-and-forget body keeps that barrel clean; the ESM module
 * cache makes every call after the first free, and the emit is already
 * asynchronous so nothing about the timing or the post-commit ordering
 * changes. `account-links-emit.test.ts` pins the absence of the static form —
 * every gate stays green without it, so only that guard catches a regression.
 */
export function emitAccountUnlinked(
  db: Database,
  facts: readonly AccountUnlinkedFacts[],
  handles: EmitHandles = {},
): void {
  const log = handles.logger ?? logger;
  for (const fact of facts) {
    void emitOne(db, fact, handles.hatchet, log).catch((error: unknown) => {
      // ATTRIBUTED, and `error` not `warn`. `emitOutbound` logs its own
      // failures with structure, so the only thing that reaches here is a
      // failure of the dynamic `import(...)` above — and Node's ESM loader
      // CACHES a module evaluation error and re-throws it on every later
      // import, so one `HatchetClient.init` throw disables `account.unlinked`
      // for the life of the process. A bare `logger.warn(err)` made that a
      // repeated context-free `Invalid token format`; an operator needs to
      // know WHICH identity fact was dropped. Never rethrows: the
      // fire-and-forget contract holds.
      log.error("account.unlinked emit failed", {
        event: "account.unlinked",
        provider: fact.provider,
        providerUserId: fact.providerUserId,
        version: fact.version,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function emitOne(
  db: Database,
  fact: AccountUnlinkedFacts,
  hatchetHandle: HatchetClient | undefined,
  log: Logger,
): Promise<void> {
  const { emitOutbound } = await import("./outbound.js");
  // Only reach for the singleton when the caller had none to give: importing
  // `./hatchet.js` is what runs `HatchetClient.init`.
  const hatchet = hatchetHandle ?? (await import("./hatchet.js")).hatchet;
  await emitOutbound({
    db,
    hatchet,
    logger: log,
    event: "account.unlinked",
    payload: buildAccountUnlinkedPayload(fact),
    dedupeKey: buildDedupeKey(fact.provider, fact.providerUserId, fact.version),
  });
}
