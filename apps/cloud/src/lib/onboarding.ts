import { and, eq, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { builds, environments, stacks, usageCounters } from "../db/schema";
import type { OrgMembersDeps } from "./org-members";
import { readMemberContext } from "./org-members";

/**
 * The first-run checklist: what a new customer still has to do.
 *
 * Every step is answered from the CONTROL PLANE's own tables — the stack row,
 * the build history, and the usage counters the metering path already writes.
 * That is the whole design constraint: a checklist that had to interrogate the
 * tenant instance would need new admin endpoints, would break whenever an
 * instance was down, and would turn a page render into a chain of live HTTP.
 *
 * So the steps are exactly the ones we can answer honestly and cheaply. There
 * is deliberately no "you have connected your code" step: nothing in this
 * database knows that, and a tick that guessed would be worse than no tick.
 */

export type OnboardingStepId = "instance" | "publish" | "event" | "email";

export interface OnboardingStep {
  id: OnboardingStepId;
  /** The imperative, in the customer's terms. */
  title: string;
  /** One line on how to do it. Absent once done — nobody needs the how then. */
  hint?: string;
  /** A command to run, when the step is one. */
  command?: string;
  /**
   * How quickly this step's answer can change.
   *
   * `live` — written the moment it happens (the stack row, the build history),
   * so a refresh can reveal it within a minute.
   * `daily` — read from `usage_counters`, which the metering cron SETS at 03:00
   * UTC. There is no faster source without new tenant admin endpoints, so the
   * honest thing is to say so on the step and to stop refreshing for it.
   */
  freshness: "live" | "daily";
  done: boolean;
}

export interface OnboardingView {
  steps: OnboardingStep[];
  /** True once every step is done — the panel stops rendering at that point. */
  complete: boolean;
  /**
   * Whether refreshing this page could still change anything.
   *
   * False once every `live` step is done: what remains is counter-backed and
   * cannot move until the nightly sweep, so polling on would be 5,760 refreshes
   * per signal — each one re-running a live HTTP call to the tenant instance.
   */
  worthRefreshing: boolean;
}

export interface OnboardingDeps extends OrgMembersDeps {
  db?: CloudDb;
}

/**
 * Null when the environment is not this caller's, mirroring
 * `readEnvironmentDetail`'s tenancy guard: a cross-tenant id and a made-up one
 * are indistinguishable from here.
 */
export async function readOnboarding(
  headers: Headers,
  input: { environmentId: string },
  deps: OnboardingDeps = {},
): Promise<OnboardingView | null> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);

  const [row] = await db
    .select({ status: stacks.status })
    .from(environments)
    .leftJoin(stacks, eq(stacks.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, input.environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [published] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(builds)
    .where(
      and(
        eq(builds.environmentId, input.environmentId),
        eq(builds.status, "succeeded"),
      ),
    );

  // Summed across every month, because "have you EVER sent one" is the
  // question — a customer who sent their first email last month has done this
  // step, and a per-month read would un-tick it on the first of the month.
  const [usage] = await db
    .select({
      events: sql<number>`coalesce(sum(${usageCounters.eventsCount}), 0)::int`,
      emails: sql<number>`coalesce(sum(${usageCounters.emailsCount}), 0)::int`,
    })
    .from(usageCounters)
    .where(eq(usageCounters.environmentId, input.environmentId));

  return buildOnboardingView({
    running: row.status === "running",
    publishedBuilds: published?.count ?? 0,
    events: usage?.events ?? 0,
    emails: usage?.emails ?? 0,
  });
}

/**
 * Pure, and separated from the read so the copy and the ordering are testable
 * without a database. Exported for that reason only.
 */
export function buildOnboardingView(input: {
  running: boolean;
  publishedBuilds: number;
  events: number;
  emails: number;
}): OnboardingView {
  const steps: OnboardingStep[] = [
    {
      id: "instance",
      title: "Your instance is running",
      freshness: "live",
      done: input.running,
    },
    {
      id: "publish",
      title: "Publish your app",
      hint: "Ship your own journeys and templates. Until you do, your instance runs the stock scaffold.",
      command: "pnpm hogsend publish",
      freshness: "live",
      done: input.publishedBuilds > 0,
    },
    {
      id: "event",
      title: "Send your first event",
      hint: "Point your app at the instance URL and track something a customer does.",
      freshness: "daily",
      done: input.events > 0,
    },
    {
      id: "email",
      title: "Send your first email",
      hint: "A journey that reaches a real person is the point of all of this.",
      freshness: "daily",
      done: input.emails > 0,
    },
  ];

  return {
    steps,
    complete: steps.every((step) => step.done),
    worthRefreshing: steps.some(
      (step) => !step.done && step.freshness === "live",
    ),
  };
}
