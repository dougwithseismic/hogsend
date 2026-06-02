import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  Eye,
  MailWarning,
  MousePointerClick,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { ErrorState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { type EmailEvent, getEmail, qk, resendEmail } from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const EVENT_ICON: Record<string, typeof Send> = {
  queued: Sparkles,
  sent: Send,
  delivered: Check,
  opened: Eye,
  clicked: MousePointerClick,
  bounced: MailWarning,
  complained: Ban,
  failed: XCircle,
};

function TimelineRow({ event }: { event: EmailEvent }) {
  const Icon = EVENT_ICON[event.type] ?? Sparkles;
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="flex h-7 w-7 items-center justify-center rounded-full border bg-card">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
        <span className="w-px flex-1 bg-border" />
      </div>
      <div className="pb-4">
        <p className="text-sm font-medium capitalize">{event.type}</p>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(event.timestamp)}
        </p>
        {event.url ? (
          <p className="mt-0.5 break-all text-xs text-muted-foreground">
            {event.url}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm">{value}</dd>
    </div>
  );
}

export function SendDetailDrawer({
  emailId,
  onClose,
}: {
  emailId: string | null;
  onClose: () => void;
}) {
  const open = emailId !== null;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmResend, setConfirmResend] = useState(false);

  const query = useQuery({
    queryKey: emailId ? qk.email(emailId) : ["email", "none"],
    queryFn: () => getEmail(emailId as string),
    enabled: open,
  });

  const resend = useMutation({
    mutationFn: () => resendEmail(emailId as string),
    onSuccess: () => {
      toast({
        title: "Resend queued",
        description: "A fresh send was queued from this template.",
      });
      setConfirmResend(false);
      void queryClient.invalidateQueries({ queryKey: ["emails"] });
      if (emailId) {
        void queryClient.invalidateQueries({ queryKey: qk.email(emailId) });
      }
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Resend failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setConfirmResend(false);
    },
  });

  const detail = query.data;
  const resendable =
    detail && ["failed", "bounced"].includes(detail.email.status);

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title="Email send"
        description={detail?.email.subject}
      >
        {query.isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : detail ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-2">
              <StatusBadge status={detail.email.status} />
              {resendable ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmResend(true)}
                >
                  <Send className="h-4 w-4" />
                  Resend
                </Button>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-4">
              <DetailField label="To" value={detail.email.toEmail} />
              <DetailField label="From" value={detail.email.fromEmail} />
              <DetailField
                label="Template"
                value={detail.email.templateKey ?? "—"}
              />
              <DetailField
                label="Category"
                value={detail.email.category ?? "—"}
              />
              <DetailField
                label="Journey"
                value={detail.email.journeyId ?? "—"}
              />
              <DetailField label="User" value={detail.email.userId ?? "—"} />
              <DetailField
                label="Resend ID"
                value={detail.email.resendId ?? "—"}
              />
              <DetailField
                label="Created"
                value={formatDateTime(detail.email.createdAt)}
              />
            </dl>

            <section>
              <h3 className="mb-3 text-sm font-semibold">Timeline</h3>
              {detail.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No delivery events recorded yet.
                </p>
              ) : (
                <ul className="[&>li:last-child>div:first-child>span:last-child]:hidden">
                  {detail.events.map((event, i) => (
                    <TimelineRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: events lack stable ids
                      key={`${event.type}-${event.timestamp}-${i}`}
                      event={event}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold">
                Tracked links ({detail.trackedLinks.length})
              </h3>
              {detail.trackedLinks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tracked links in this email.
                </p>
              ) : (
                <ul className="space-y-2">
                  {detail.trackedLinks.map((link) => (
                    <li
                      key={link.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <span className="break-all text-sm">
                        {link.originalUrl}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {link.clickCount} click
                        {link.clickCount === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmResend}
        onClose={() => setConfirmResend(false)}
        onConfirm={() => resend.mutate()}
        title="Resend this email?"
        description="A new send will be queued from the original template and recipient."
        confirmLabel="Resend"
        loading={resend.isPending}
      />
    </>
  );
}
