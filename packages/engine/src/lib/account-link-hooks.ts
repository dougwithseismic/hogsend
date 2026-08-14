import type { AccountLinkHooks, BeforeLinkContext } from "@hogsend/core";
import { ACCOUNT_LINK_HOOK_TIMEOUT_MS } from "@hogsend/core";
import type { Logger } from "./logger.js";

/**
 * The `beforeLink` veto runner — FAIL-CLOSED (DECISIONS §6.7).
 *
 * A throw, a timeout at {@link ACCOUNT_LINK_HOOK_TIMEOUT_MS}, and an explicit
 * `{ allow: false }` all collapse to one outcome: `{ allow: false, reason:
 * "vetoed" }`. A `void`/`undefined` return ALLOWS, per PRD 01's
 * `BeforeLinkResult` — denial is never implicit, so a hook that only observes
 * cannot accidentally veto every link. There is no third outcome and no config
 * flag that turns the veto into a warning.
 *
 * **`runBeforeLink` is the ONLY export of this file, deliberately.**
 * `afterLink` / `afterUnlink` have exactly one invoker — the link store,
 * post-commit (DECISIONS §15.4) — and a second bounded runner living here is
 * precisely how they end up firing twice for every link, invisibly, because
 * they are documented at-least-once and nothing would fail loudly. The veto is
 * genuinely route-owned because it is pre-write and the hosted callback is the
 * only pre-write position. If a bounded fail-OPEN runner is ever wanted
 * elsewhere, it lives in `lib/account-links.ts` beside the commit it follows.
 */
export async function runBeforeLink(args: {
  hooks: AccountLinkHooks;
  ctx: BeforeLinkContext;
  logger?: Logger;
}): Promise<{ allow: true } | { allow: false; reason: "vetoed" }> {
  const hook = args.hooks.beforeLink;
  if (!hook) return { allow: true };

  let timer: NodeJS.Timeout | undefined;
  try {
    const verdict = await Promise.race([
      // `Promise.resolve(...)` inside the try so a SYNCHRONOUS throw — which
      // escapes before any promise exists — is caught by the same handler.
      Promise.resolve(hook(args.ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `beforeLink exceeded ${ACCOUNT_LINK_HOOK_TIMEOUT_MS}ms`,
              ),
            ),
          ACCOUNT_LINK_HOOK_TIMEOUT_MS,
        );
      }),
    ]);
    if (verdict && verdict.allow === false) {
      args.logger?.warn("accountLink beforeLink vetoed the link", {
        provider: args.ctx.provider,
        contactId: args.ctx.contactId,
        // Operator-facing by contract; a hook must not put a secret here.
        reason: verdict.reason,
      });
      return { allow: false, reason: "vetoed" };
    }
    return { allow: true };
  } catch (err) {
    // A throw and a timeout are the SAME outcome. Fail-closed lives on the
    // failure channel, so neither an exception nor a hung customer service can
    // wave a link through.
    args.logger?.warn("accountLink beforeLink failed — link refused", {
      provider: args.ctx.provider,
      contactId: args.ctx.contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allow: false, reason: "vetoed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
