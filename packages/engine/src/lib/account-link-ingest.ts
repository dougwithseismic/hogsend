import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { AnalyticsProvider } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import type { AccountUnlinkedFacts } from "./account-link-events.js";
import { buildDedupeKey } from "./account-link-events.js";
import type { LinkAccountResult } from "./account-links.js";
import { getAnalytics } from "./analytics-singleton.js";
import { createLogger, type Logger } from "./logger.js";

/**
 * THE JOURNEY PLANE for account links (PRD 08 T5).
 *
 * ## TWO PLANES. NEITHER MAY BE COLLAPSED INTO THE OTHER.
 *
 * Every call to a function here sits BESIDE a call to the outbound spine
 * (`emitOutbound` / `emitAccountUnlinked` / `noteUnlinked`), and the two look
 * redundant precisely because they carry the same fact. They are not:
 *
 *  - the OUTBOUND plane (`lib/outbound.ts`) writes a `webhook_deliveries` row
 *    and ships full current state to the CUSTOMER'S subscriber. It is emitted
 *    from the intent layer ONLY (DECISIONS §8), and the ingest path never
 *    emits.
 *  - the JOURNEY plane (this file → `ingestEvent`) writes a `user_events` row
 *    and pushes to Hatchet so `defineJourney({ trigger: { event:
 *    "account.linked" } })` fires INSIDE Hogsend. It reaches no subscriber.
 *
 * Delete either one and the other silently keeps working, so nothing fails
 * loudly: an outbound-only build leaves every account-link journey dead, and an
 * ingest-only build leaves every customer mirror stale. **Do not "simplify" the
 * pair into one call**, and do not make `ingestEvent` emit or `emitOutbound`
 * ingest — the `group.*` precedent (`routes/groups/index.ts`) is that the
 * intent layer emits and the ingest path does not, and that boundary is what
 * keeps a re-ingest from fanning a second delivery out to every subscriber.
 *
 * ## SCALARS ONLY in `eventProperties` (DECISIONS §8)
 *
 * Journeys branch on `eventProperties`; `contactProperties` never reach the
 * Hatchet payload, and `ingestEvent` itself FILTERS the push payload down to
 * `string | number | boolean | null` (`ingestion.ts` step 3). So a nested
 * object or an array added here does not fail — it is silently dropped between
 * `user_events` and the journey, and a `where` clause referencing it never
 * matches. Same correction as `cold-connect/index.ts:45-49`. Every property
 * built below is a literal scalar, and
 * `apps/api/src/__tests__/accounts-journey-trigger.test.ts` iterates the stored
 * row asserting `typeof`, so a future field of the wrong shape fails there.
 *
 * ## IDENTITY: the provenance pin, never the bare canonical key
 *
 * `owner.userId` is `contactKey()` (`external_id ?? anonymous_id ?? id`), so
 * for a cold Steam link — the case this feature creates MOST of — it is an
 * ANONYMOUS id. Passing that alone as `event.userId` would have `findByKey`
 * read it as kind `external` and mint a row with `external_id = <anonId>`,
 * which then trips `collidesWithIdentified` and locks the visitor out of their
 * own feed: strictly worse than the ghost row it would avoid. So every state
 * event also carries `contactId: owner.contactId`, the ENGINE-INTERNAL
 * provenance pin, which resolves the exact row by uuid (and follows a merge
 * alias to the survivor) and can never mint. The `userId` is still supplied
 * because the resolver requires at least one value key, but the pin wins the
 * branch (`contacts.ts` step −1).
 *
 * ## Replay safety — none to reach for, deliberately
 *
 * These calls run in ROUTE-HANDLER runtime (the hosted callback, the data
 * plane) or in post-commit library code (the merge fold), never inside a
 * Hatchet durable task, so nothing here enters any journey's replay journal.
 * The idempotency is the `user_events.idempotency_key` unique index, fed the
 * SAME `al:<provider>:<uid>:v<version>` string the outbound `dedupeKey` uses —
 * so a retried callback routes at most one enrollment. A journey that REACTS
 * to `account.linked` is an ordinary event-triggered journey and obeys every
 * existing replay law unchanged.
 */

// The engine singletons, the `lib/account-link-emit.ts` idiom: the
// `lib/contacts.ts` call site is reached from library code with no request
// container to read a registry/analytics/logger off. A caller that DOES have
// one passes it.
const fallbackLogger = createLogger(process.env.LOG_LEVEL);

/** The container's handles, when the caller has a container. */
export interface AccountLinkIngestHandles {
  registry?: JourneyRegistry;
  hatchet?: HatchetClient;
  logger?: Logger;
  analytics?: AnalyticsProvider;
}

/** The two {@link LinkAccountResult} arms that actually bound something. */
type LinkedFacts = Extract<
  LinkAccountResult,
  { status: "linked" } | { status: "relinked" }
>;

/**
 * The subject a failed link can be attributed to, or `null` for none.
 *
 * `contactId` is the SEALED, server-minted id from a state that verified —
 * unforgeable. `anonymousId` is the COLD path's browser-supplied value, which
 * is why that arm is both `collidesWithIdentified`-screened and refused
 * creation below.
 */
export type LinkFailedSubject =
  | { contactId: string; anonymousId?: undefined }
  | { anonymousId: string; contactId?: undefined }
  | null;

/**
 * `account.linked` onto the journey plane, beside the outbound emit.
 *
 * Fire-and-forget with an attributed catch, exactly like
 * `emitAccountUnlinked`: a Hatchet hiccup or an uninitialized registry must
 * never fail a link the player already completed. Returns `void` so there is
 * deliberately nothing for a caller to await and therefore nothing for a
 * caller to accidentally fail on.
 */
export function ingestAccountLinked(
  db: Database,
  facts: LinkedFacts,
  handles: AccountLinkIngestHandles = {},
): void {
  const { provider, providerUserId } = facts.row;
  run(
    db,
    handles,
    {
      event: "account.linked",
      // `LinkOwner.userId` is TYPED nullable, so fall back to the row uuid —
      // which `findByKey` resolves to the same contact by id. The value key
      // only has to exist (the resolver requires one); the pin below is what
      // actually decides the row.
      userId: facts.owner.userId ?? facts.owner.contactId,
      contactId: facts.owner.contactId,
      eventProperties: {
        state: "linked",
        provider,
        providerUserId,
        username: facts.row.username,
        method: facts.row.method,
        relink: facts.relink,
        version: facts.version,
      },
      source: "account_link",
      idempotencyKey: buildDedupeKey(provider, providerUserId, facts.version),
    },
    { provider, providerUserId, version: facts.version },
  );
}

/**
 * `account.unlinked` onto the journey plane, beside the outbound emit.
 *
 * Keyed on the facts' OWN pair — a `replacedSingleton` is a DIFFERENT pair
 * with its own version sequence, and a key built from the arriving pair would
 * collide with the `account.linked` idempotency key and silently drop this
 * enrollment.
 */
export function ingestAccountUnlinked(
  db: Database,
  facts: AccountUnlinkedFacts,
  handles: AccountLinkIngestHandles = {},
): void {
  run(
    db,
    handles,
    {
      event: "account.unlinked",
      // Nullable by type only — see {@link ingestAccountLinked}.
      userId: facts.owner.userId ?? facts.owner.contactId,
      contactId: facts.owner.contactId,
      eventProperties: {
        state: "unlinked",
        provider: facts.provider,
        providerUserId: facts.providerUserId,
        reason: facts.reason,
        version: facts.version,
      },
      source: "account_link",
      idempotencyKey: buildDedupeKey(
        facts.provider,
        facts.providerUserId,
        facts.version,
      ),
    },
    {
      provider: facts.provider,
      providerUserId: facts.providerUserId,
      version: facts.version,
    },
  );
}

/**
 * `account.link_failed` onto the journey plane, beside the outbound emit.
 *
 * NO `idempotencyKey`, mirroring the missing `dedupeKey`: the event carries no
 * version, and two genuine failures in a row are two genuine facts.
 *
 * `allowCreate: false` is MANDATORY here (DECISIONS §8) and is what
 * STRUCTURALLY enforces "a failed link never mints a contact" — rather than
 * relying on the caller happening to pass no identity. On the cold arm the key
 * is an `anonymous_id` typed into an unauthenticated URL, so a creating
 * resolve would mint a CRM row for a link that never happened, on a value the
 * visitor chose.
 *
 * A `null` subject is a no-op, not an error: a state that did not verify
 * carries nothing to attribute a failure to, and `resolveContactNoCreate`
 * would throw anyway (D8 — it needs `userId` or `anonymousId`).
 */
export function ingestAccountLinkFailed(
  db: Database,
  args: {
    provider: string;
    reason: "denied" | "vetoed" | "exchange_failed" | "state_invalid";
    subject: LinkFailedSubject;
  },
  handles: AccountLinkIngestHandles = {},
): void {
  const { subject } = args;
  if (!subject) return;
  const eventProperties = {
    provider: args.provider,
    reason: args.reason,
  };
  const context = { provider: args.provider, providerUserId: null };
  if (subject.contactId !== undefined) {
    run(
      db,
      handles,
      {
        event: "account.link_failed",
        // The uuid doubles as the value key: `findByKey` resolves a
        // uuid-shaped `external` key straight to that row. Supplied because
        // the resolver requires at least one value key; the pin beside it wins
        // the branch either way.
        userId: subject.contactId,
        contactId: subject.contactId,
        eventProperties,
        source: "account_link",
      },
      context,
      { allowCreate: false },
    );
    return;
  }
  run(
    db,
    handles,
    {
      event: "account.link_failed",
      anonymousId: subject.anonymousId,
      eventProperties,
      source: "account_link",
    },
    context,
    { allowCreate: false, screenAnonymousId: subject.anonymousId },
  );
}

/** What `ingestEvent` is handed, narrowed to the fields these three build. */
interface AccountLinkIngestEvent {
  event: "account.linked" | "account.unlinked" | "account.link_failed";
  userId?: string;
  anonymousId?: string;
  contactId?: string;
  eventProperties: Record<string, string | number | boolean | null>;
  source: string;
  idempotencyKey?: string;
}

/**
 * The one place `ingestEvent` is reached from, so the fire-and-forget contract,
 * the singleton fallbacks and the failure log cannot drift across the three
 * builders above.
 *
 * ## `./ingestion.js` and `./contacts.js` are reached by DYNAMIC import
 *
 * `lib/contacts.ts` imports THIS module (the merge fold's post-commit
 * `account.unlinked`) and `lib/ingestion.ts` imports `lib/contacts.ts`, so a
 * static import here is a module cycle. It is also the
 * `lib/account-link-emit.ts` hazard verbatim: `src/testing.ts` re-exports from
 * `lib/contacts.ts`, and `ingestion.ts` reaches `lib/hatchet.js`, whose import
 * runs `HatchetClient.init(...)` and throws `Invalid token format` where no
 * real token exists. Resolving inside the async body keeps that barrel clean;
 * the ESM module cache makes every call after the first free.
 */
function run(
  db: Database,
  handles: AccountLinkIngestHandles,
  event: AccountLinkIngestEvent,
  context: {
    provider: string;
    providerUserId: string | null;
    version?: string;
  },
  opts: { allowCreate?: boolean; screenAnonymousId?: string } = {},
): void {
  const logger = handles.logger ?? fallbackLogger;
  void ingestOne(db, handles, event, opts, logger).catch((error: unknown) => {
    // ATTRIBUTED, and `error` not `warn`: the journey plane going quiet is
    // invisible from the outbound plane (which kept working), so an operator
    // needs to know WHICH fact failed to route.
    logger.error("account link journey re-ingest failed", {
      event: event.event,
      provider: context.provider,
      providerUserId: context.providerUserId,
      version: context.version ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function ingestOne(
  db: Database,
  handles: AccountLinkIngestHandles,
  event: AccountLinkIngestEvent,
  opts: { allowCreate?: boolean; screenAnonymousId?: string },
  logger: Logger,
): Promise<void> {
  if (opts.screenAnonymousId !== undefined) {
    // The cold arm's key arrives on an unauthenticated URL. `allowCreate:
    // false` already stops it MINTING, but it would still file a
    // `user_events` row under the canonical key of whatever identified
    // contact the value names — injecting a fake `account.link_failed` into a
    // victim's timeline for any journey to trigger on. This is the same guard
    // the engine already applies at its other token-less anon-id-accepting
    // surfaces (`feed/recipient.ts`, `tracking/arrive.ts`, and the cold leg of
    // the account-link callback itself).
    const { collidesWithIdentified } = await import("./contacts.js");
    if (await collidesWithIdentified(db, opts.screenAnonymousId)) {
      logger.warn(
        "account.link_failed re-ingest skipped: the cold anonymous id names " +
          "an identified contact",
        { event: event.event },
      );
      return;
    }
  }
  const { ingestEvent } = await import("./ingestion.js");
  // Only reach for the singleton when the caller had none to give: importing
  // `./hatchet.js` is what runs `HatchetClient.init`.
  const hatchet = handles.hatchet ?? (await import("./hatchet.js")).hatchet;
  const analytics = handles.analytics ?? getAnalytics();
  await ingestEvent({
    db,
    registry: handles.registry ?? getJourneyRegistrySingleton(),
    hatchet,
    logger,
    event,
    ...(analytics ? { analytics } : {}),
    ...(opts.allowCreate === false ? { allowCreate: false } : {}),
  });
}
