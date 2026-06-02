import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Mail, Zap } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  getContact,
  getContactActivity,
  getContactTimeline,
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
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-card">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{title}</p>
          {entry.type === "email" && data.status ? (
            <StatusBadge status={String(data.status)} />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(entry.timestamp)}
        </p>
      </div>
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

  const unsuppress = useMutation({
    mutationFn: () =>
      updateContactPreferences(contactId as string, { suppressed: false }),
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
                  className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
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
                <dt className="text-xs text-muted-foreground">First seen</dt>
                <dd className="text-sm">
                  {formatDateTime(contact.firstSeenAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last seen</dt>
                <dd className="text-sm">
                  {formatDateTime(contact.lastSeenAt)}
                </dd>
              </div>
            </dl>

            <section>
              <h3 className="mb-3 text-sm font-semibold">
                Email activity
                {activityQuery.data ? ` (${activityQuery.data.total})` : ""}
              </h3>
              {activityQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : activityQuery.isError ? (
                <p className="text-sm text-muted-foreground">
                  Could not load email activity.
                </p>
              ) : activityQuery.data && activityQuery.data.sends.length > 0 ? (
                <ul className="space-y-2">
                  {activityQuery.data.sends.slice(0, 10).map((send) => (
                    <li
                      key={send.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {send.subject}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(send.createdAt)}
                        </p>
                      </div>
                      <StatusBadge status={send.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No emails sent.</p>
              )}
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
              {timelineQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : timelineQuery.isError ? (
                <p className="text-sm text-muted-foreground">
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
                <p className="text-sm text-muted-foreground">
                  No activity yet.
                </p>
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
