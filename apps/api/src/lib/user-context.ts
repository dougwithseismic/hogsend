import type { JourneyContext, JourneyUser, RecentEvent } from "@hogsend/engine";
import { getPostHog } from "@hogsend/engine";

export interface EmailEngagementSummary {
  /** Whether the user has opened at least one email. */
  everOpened: boolean;
  /** Whether the user has clicked at least one email link. */
  everClicked: boolean;
}

export interface UserContext {
  contact: {
    id: string;
    email: string;
    properties: Record<string, string | number | boolean | null>;
  };
  /** Up to 50 most recent user events, newest first. */
  events: RecentEvent[];
  /** Aggregate email engagement signals for this user. */
  email: EmailEngagementSummary;
  /** PostHog person properties — present when `POSTHOG_PERSONAL_API_KEY` is set. */
  posthog?: Record<string, unknown>;
}

/**
 * Assemble a rich user-context bundle for AI agents.
 *
 * Composes:
 * - `contact` — stable identity (id, email, journey contact properties)
 * - `events` — the 50 most recent user events, newest first
 * - `email` — aggregate email engagement signals (open/click) from the
 *   tracking spine (first-party events stored via `ingestEvent`)
 * - `posthog` — person properties from PostHog (omitted when unavailable)
 *
 * Intended to be passed directly to an agent function so it can make
 * informed decisions without additional DB lookups.
 */
export async function getUserContext(
  ctx: JourneyContext,
  user: JourneyUser,
): Promise<UserContext> {
  const [events, openedResult, clickedResult, posthogProps] = await Promise.all(
    [
      ctx.history.events({ userId: user.id, limit: 50 }),
      ctx.history.hasEvent({ userId: user.id, event: "email.opened" }),
      ctx.history.hasEvent({ userId: user.id, event: "email.link_clicked" }),
      getPostHog()?.getPersonProperties(user.id) ?? Promise.resolve(undefined),
    ],
  );

  const context: UserContext = {
    contact: {
      id: user.id,
      email: user.email,
      properties: user.properties,
    },
    events,
    email: {
      everOpened: openedResult.found,
      everClicked: clickedResult.found,
    },
  };

  if (posthogProps !== undefined) {
    context.posthog = posthogProps;
  }

  return context;
}
