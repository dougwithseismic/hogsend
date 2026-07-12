import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Mail, Zap } from "lucide-react";
import { useState } from "react";
import { PropertyTable } from "@/components/property-table";
import { ErrorState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  type DefinedListMeta,
  getContact,
  getContactActivity,
  getContactTimeline,
  listDefinedLists,
  qk,
  type TimelineEntry,
  updateContactPreferences,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const TIMELINE_ICON = {
  event: Zap,
  journey: GitBranch,
  email: Mail,
} as const;

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const Icon = TIMELINE_ICON[entry.type];
  const data = entry.data;
  const title =
    entry.type === "event"
      ? String(data.event ?? "event")
      : entry.type === "journey"
        ? `${String(data.journeyId ?? "journey")} · ${String(data.status ?? "")}`
        : String(data.subject ?? data.templateKey ?? "email");
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline-faint bg-white/[0.04]">
        <Icon className="h-3.5 w-3.5 text-white/50" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          {entry.type === "email" && data.status ? (
            <StatusBadge status={String(data.status)} />
          ) : null}
        </div>
        <p className="text-xs text-white/50">
          {formatDateTime(entry.timestamp)}
        </p>
      </div>
    </li>
  );
}

function PrefRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-hairline-faint bg-white/[0.015] px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{label}</p>
        {description ? (
          <p className="truncate text-xs text-white/50">{description}</p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={onCheckedChange}
      />
    </li>
  );
}

export function ContactDetailDrawer({
  contactId,
  onClose,
}: {
  contactId: string | null;
  onClose: () => void;
}) {
  const open = contactId !== null;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmUnsuppress, setConfirmUnsuppress] = useState(false);

  const contactQuery = useQuery({
    queryKey: contactId ? qk.contact(contactId) : ["contact", "none"],
    queryFn: () => getContact(contactId as string),
    enabled: open,
  });
  const activityQuery = useQuery({
    queryKey: contactId ? qk.contactActivity(contactId) : ["activity", "none"],
    queryFn: () => getContactActivity(contactId as string),
    enabled: open,
  });
  const timelineQuery = useQuery({
    queryKey: contactId ? qk.contactTimeline(contactId) : ["timeline", "none"],
    queryFn: () => getContactTimeline(contactId as string),
    enabled: open,
  });
  const listsQuery = useQuery({
    queryKey: qk.lists,
    queryFn: listDefinedLists,
    enabled: open,
  });

  const updatePrefs = useMutation({
    mutationFn: (body: {
      unsubscribedAll?: boolean;
      categories?: Record<string, boolean>;
    }) => updateContactPreferences(contactId as string, body),
    onSuccess: () => {
      // Refetch the contact so the switches reflect server truth (the PUT
      // replaces the whole categories map / upserts the pref row).
      if (contactId) {
        void queryClient.invalidateQueries({ queryKey: qk.contact(contactId) });
      }
      // A master-toggle can add/remove the contact from the suppression list.
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Update failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const unsuppress = useMutation({
    // Clear BOTH flags — an unsubscribe is a suppression reason too, so dropping
    // only `suppressed` would leave an unsubscribed contact stuck (and still on
    // the suppression list). Mirrors the suppressions-view restore action.
    mutationFn: () =>
      updateContactPreferences(contactId as string, {
        suppressed: false,
        unsubscribedAll: false,
      }),
    onSuccess: () => {
      toast({
        title: "Contact un-suppressed",
        description: "They can receive emails again.",
      });
      setConfirmUnsuppress(false);
      if (contactId) {
        void queryClient.invalidateQueries({ queryKey: qk.contact(contactId) });
      }
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Un-suppress failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setConfirmUnsuppress(false);
    },
  });

  const contact = contactQuery.data?.contact;
  const prefs = contactQuery.data?.preferences;
  const isSuppressed = prefs?.suppressed || prefs?.unsubscribedAll;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={contact?.email ?? contact?.externalId ?? "Contact"}
        description={contact ? contact.externalId : undefined}
      >
        {contactQuery.isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : contactQuery.isError ? (
          <ErrorState
            error={contactQuery.error}
            onRetry={() => contactQuery.refetch()}
          />
        ) : contact ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              {prefs?.suppressed ? (
                <Badge variant="destructive">Suppressed</Badge>
              ) : null}
              {prefs?.unsubscribedAll ? (
                <Badge variant="destructive">Unsubscribed</Badge>
              ) : null}
              {prefs && prefs.bounceCount > 0 ? (
                <Badge variant="secondary">
                  {prefs.bounceCount} bounce
                  {prefs.bounceCount === 1 ? "" : "s"}
                </Badge>
              ) : null}
              {!isSuppressed ? (
                <Badge
                  variant="outline"
                  className="border-white/15 bg-white/[0.06] text-white/80"
                >
                  Subscribed
                </Badge>
              ) : null}
              {isSuppressed ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setConfirmUnsuppress(true)}
                >
                  Un-suppress
                </Button>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-white/50">First seen</dt>
                <dd className="text-sm text-white">
                  {formatDateTime(contact.firstSeenAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-white/50">Last seen</dt>
                <dd className="text-sm text-white">
                  {formatDateTime(contact.lastSeenAt)}
                </dd>
              </div>
            </dl>

            {(() => {
              const revenue = contactQuery.data?.revenue;
              if (!revenue || revenue.totals.length === 0) return null;
              const fmt = (total: number, currency: string | null) =>
                currency
                  ? new Intl.NumberFormat(undefined, {
                      style: "currency",
                      currency,
                    }).format(total)
                  : total.toLocaleString();
              return (
                <section>
                  <h3 className="eyebrow mb-3 text-white/50">Revenue</h3>
                  <dl className="grid grid-cols-2 gap-3">
                    {revenue.totals.map((t) => (
                      <div key={t.currency ?? "none"}>
                        <dt className="text-xs text-white/50">
                          {t.currency ?? "No currency"} · {t.count}{" "}
                          {t.count === 1 ? "event" : "events"}
                        </dt>
                        <dd className="text-sm font-medium text-white">
                          {fmt(t.total, t.currency)}
                        </dd>
                      </div>
                    ))}
                    {revenue.lastValuedAt ? (
                      <div>
                        <dt className="text-xs text-white/50">Last valued</dt>
                        <dd className="text-sm text-white">
                          {formatDateTime(revenue.lastValuedAt)}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
              );
            })()}

            <section>
              <h3 className="eyebrow mb-3 text-white/50">Preferences</h3>
              {listsQuery.isPending ? (
                <Skeleton className="h-24 w-full" />
              ) : listsQuery.isError ? (
                <p className="text-sm text-white/60">
                  Could not load subscription lists.
                </p>
              ) : (
                (() => {
                  const lists = listsQuery.data?.lists ?? [];
                  const channels = lists.filter((l) => l.kind === "channel");
                  const topics = lists.filter((l) => l.kind === "topic");
                  const cats = prefs?.categories ?? {};
                  const listRow = (l: DefinedListMeta) => (
                    <PrefRow
                      key={l.id}
                      label={l.name}
                      description={l.description}
                      checked={cats[l.id] ?? l.defaultOptIn}
                      disabled={updatePrefs.isPending}
                      onCheckedChange={(next) =>
                        updatePrefs.mutate({
                          categories: { ...cats, [l.id]: next },
                        })
                      }
                    />
                  );
                  return (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-white/40">
                          Channels
                        </p>
                        <ul className="space-y-2">
                          <PrefRow
                            label="Email"
                            description="Master switch — turns off all email."
                            checked={!prefs?.unsubscribedAll}
                            disabled={updatePrefs.isPending}
                            onCheckedChange={(next) =>
                              updatePrefs.mutate({ unsubscribedAll: !next })
                            }
                          />
                          {channels.map(listRow)}
                        </ul>
                      </div>
                      {topics.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-white/40">
                            Topics
                          </p>
                          <ul className="space-y-2">{topics.map(listRow)}</ul>
                        </div>
                      ) : null}
                    </div>
                  );
                })()
              )}
            </section>

            <section>
              <h3 className="eyebrow mb-3 text-white/50">Properties</h3>
              <PropertyTable
                properties={contact.properties}
                emptyLabel="No properties set on this contact."
              />
            </section>

            <section>
              <h3 className="eyebrow mb-3 text-white/50">
                Email activity
                {activityQuery.data ? ` (${activityQuery.data.total})` : ""}
              </h3>
              {activityQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : activityQuery.isError ? (
                <p className="text-sm text-white/60">
                  Could not load email activity.
                </p>
              ) : activityQuery.data && activityQuery.data.sends.length > 0 ? (
                <ul className="space-y-2">
                  {activityQuery.data.sends.slice(0, 10).map((send) => (
                    <li
                      key={send.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-white/[0.015] p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">
                          {send.subject}
                        </p>
                        <p className="text-xs text-white/50">
                          {formatDateTime(send.createdAt)}
                        </p>
                      </div>
                      <StatusBadge status={send.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-white/60">No emails sent.</p>
              )}
            </section>

            <section>
              <h3 className="eyebrow mb-3 text-white/50">Timeline</h3>
              {timelineQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : timelineQuery.isError ? (
                <p className="text-sm text-white/60">
                  Could not load timeline.
                </p>
              ) : timelineQuery.data &&
                timelineQuery.data.timeline.length > 0 ? (
                <ul>
                  {timelineQuery.data.timeline.map((entry, i) => (
                    <TimelineItem
                      // biome-ignore lint/suspicious/noArrayIndexKey: timeline entries lack stable ids
                      key={`${entry.type}-${entry.timestamp}-${i}`}
                      entry={entry}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-white/60">No activity yet.</p>
              )}
            </section>
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmUnsuppress}
        onClose={() => setConfirmUnsuppress(false)}
        onConfirm={() => unsuppress.mutate()}
        title="Un-suppress this contact?"
        description="They will be eligible to receive emails again."
        confirmLabel="Un-suppress"
        loading={unsuppress.isPending}
      />
    </>
  );
}
