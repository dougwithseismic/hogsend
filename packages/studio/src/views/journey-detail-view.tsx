import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  getJourney,
  getJourneyState,
  getJourneyTemplates,
  getTemplatePreview,
  type JourneyCondition,
  type JourneyDetail,
  type JourneyStateStatus,
  type JourneyStatesFilter,
  listJourneyStates,
  qk,
  setJourneyEnabled,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import {
  formatDateTime,
  formatDurationObject,
  formatNumber,
} from "@/lib/format";
import { JourneyFlow } from "./journeys/journey-flow";
import { JourneyFunnel } from "./journeys/journey-funnel";

const PAGE_SIZE = 25;

const STATUS_FILTERS: Array<{
  label: string;
  value: JourneyStateStatus | "all";
}> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Waiting", value: "waiting" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Exited", value: "exited" },
];

/** Render a condition object readably: "score lte 6", else its JSON. */
function formatCondition(c: JourneyCondition): string {
  const prop = c.property ?? c.field;
  const op = c.operator ?? c.op;
  if (typeof prop === "string" && typeof op === "string") {
    return `${prop} ${op} ${JSON.stringify(c.value ?? null)}`;
  }
  return JSON.stringify(c);
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
      {children}
    </h4>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border bg-black/30 p-3 font-mono text-xs text-white/70">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ConditionList({ where }: { where?: JourneyCondition[] }) {
  if (!where || where.length === 0) {
    return <span className="text-white/40">any</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {where.map((c) => (
        <code
          key={formatCondition(c)}
          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/80"
        >
          {formatCondition(c)}
        </code>
      ))}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <span className="w-24 shrink-0 text-sm text-white/50">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white/90">{children}</div>
    </div>
  );
}

function JourneyMetaCard({ journey }: { journey: JourneyDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Definition</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {journey.description ? (
          <p className="text-sm text-white/70">{journey.description}</p>
        ) : null}
        <MetaRow label="Trigger">
          <div className="space-y-1.5">
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-accent">
              {journey.trigger.event}
            </code>
            <ConditionList where={journey.trigger.where} />
          </div>
        </MetaRow>
        <MetaRow label="Exit on">
          {journey.exitOn && journey.exitOn.length > 0 ? (
            <div className="space-y-2">
              {journey.exitOn.map((ex) => (
                <div
                  key={`${ex.event}:${JSON.stringify(ex.where ?? [])}`}
                  className="space-y-1"
                >
                  <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/80">
                    {ex.event}
                  </code>
                  <ConditionList where={ex.where} />
                </div>
              ))}
            </div>
          ) : (
            <span className="text-white/40">none</span>
          )}
        </MetaRow>
        <MetaRow label="Entry limit">{journey.entryLimit}</MetaRow>
        <MetaRow label="Suppress">
          {formatDurationObject(journey.suppress) ?? "none"}
        </MetaRow>
      </CardContent>
    </Card>
  );
}

function TemplatePreviewFrame({ templateKey }: { templateKey: string }) {
  const preview = useQuery({
    queryKey: qk.templatePreview(templateKey),
    queryFn: () => getTemplatePreview(templateKey),
  });

  if (preview.isPending) return <Skeleton className="h-[400px] w-full" />;
  if (preview.isError) {
    return (
      <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-white">
      <iframe
        title={`${templateKey} preview`}
        srcDoc={preview.data.html}
        sandbox=""
        className="h-[600px] w-full"
      />
    </div>
  );
}

function JourneyEmailsCard({ journeyId }: { journeyId: string }) {
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const query = useQuery({
    queryKey: qk.journeyTemplates(journeyId),
    queryFn: () => getJourneyTemplates(journeyId),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <p className="text-xs text-white/40">
          Email sends only — other channels (Discord, Telegram) aren't shown
          here.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.data.templates.length === 0 ? (
          <p className="text-sm text-white/50">
            No emails sent in this journey yet. Templates appear here once the
            journey has sent them.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead className="text-right">Clicked</TableHead>
                  <TableHead>Last sent</TableHead>
                  <TableHead className="text-right">Preview</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.templates.map((t) => (
                  <TableRow key={t.templateKey}>
                    <TableCell className="font-mono text-xs text-white/90">
                      {t.templateKey}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(t.sent)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(t.opened)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(t.clicked)}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {t.lastSentAt ? formatDateTime(t.lastSentAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setPreviewKey((cur) =>
                            cur === t.templateKey ? null : t.templateKey,
                          )
                        }
                      >
                        {previewKey === t.templateKey ? "Hide" : "Preview"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {previewKey ? (
              <TemplatePreviewFrame templateKey={previewKey} />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (next: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  return (
    <div className="flex items-center justify-between text-sm text-white/50">
      <span>
        {from}–{to} of {formatNumber(total)}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => onChange(offset + PAGE_SIZE)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function JourneyInstanceDrawer({
  journeyId,
  stateId,
  onClose,
}: {
  journeyId: string;
  stateId: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: qk.journeyState(journeyId, stateId ?? ""),
    queryFn: () => getJourneyState(journeyId, stateId as string),
    enabled: stateId !== null,
  });

  return (
    <Drawer
      open={stateId !== null}
      onClose={onClose}
      title="Journey instance"
      description={stateId ?? undefined}
    >
      {stateId === null ? null : query.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={query.data.state.status} />
              <span className="text-sm text-white/70">
                {query.data.state.userEmail || query.data.state.userId}
              </span>
            </div>
            <p className="text-xs text-white/40">
              Entered {formatDateTime(query.data.state.createdAt)} · updated{" "}
              {formatDateTime(query.data.state.updatedAt)}
            </p>
            {query.data.state.errorMessage ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                {query.data.state.errorMessage}
              </p>
            ) : null}
          </div>

          <section className="space-y-2">
            <SectionHeading>Transitions</SectionHeading>
            {query.data.logs.length === 0 ? (
              <p className="text-sm text-white/50">
                No transitions logged yet.
              </p>
            ) : (
              <ol className="space-y-2">
                {query.data.logs.map((log) => (
                  <li
                    key={log.id}
                    className="space-y-1 rounded-md border bg-white/[0.015] p-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-white/80">
                        {log.action}
                      </span>
                      <span className="shrink-0 text-white/40">
                        {formatDateTime(log.createdAt)}
                      </span>
                    </div>
                    {log.fromNodeId || log.toNodeId ? (
                      <p className="font-mono text-white/50">
                        {log.fromNodeId ?? "·"} → {log.toNodeId ?? "·"}
                      </p>
                    ) : null}
                    {log.detail ? <JsonBlock value={log.detail} /> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {Object.keys(query.data.state.context).length > 0 ? (
            <section className="space-y-2">
              <SectionHeading>Enrollment context</SectionHeading>
              <JsonBlock value={query.data.state.context} />
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function JourneyStatesBrowser({ journeyId }: { journeyId: string }) {
  const [status, setStatus] = useState<JourneyStateStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);

  const filter: JourneyStatesFilter = {
    status: status === "all" ? undefined : status,
    limit: PAGE_SIZE,
    offset,
  };
  const query = useQuery({
    queryKey: qk.journeyStates(journeyId, filter),
    queryFn: () => listJourneyStates(journeyId, filter),
  });

  const states = query.data?.states ?? [];
  const total = query.data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instances</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={status === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setStatus(f.value);
                setOffset(0);
              }}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {query.isPending ? (
          <TableSkeleton />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : states.length === 0 ? (
          <EmptyState
            title="No instances"
            description="No users have entered this journey with the selected filter."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead className="text-right">Entries</TableHead>
                  <TableHead>Entered</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {states.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedStateId(s.id)}
                  >
                    <TableCell className="text-white/90">
                      {s.userEmail || s.userId}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-white/60">
                      {s.currentNodeId || "—"}
                    </TableCell>
                    <TableCell className="text-right text-white/60">
                      {s.entryCount}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {formatDateTime(s.createdAt)}
                    </TableCell>
                    <TableCell className="text-white/60">
                      {formatDateTime(s.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination offset={offset} total={total} onChange={setOffset} />
          </>
        )}
      </CardContent>

      <JourneyInstanceDrawer
        journeyId={journeyId}
        stateId={selectedStateId}
        onClose={() => setSelectedStateId(null)}
      />
    </Card>
  );
}

export function JourneyDetailView({ journeyId }: { journeyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmToggle, setConfirmToggle] = useState(false);

  const query = useQuery({
    queryKey: qk.journey(journeyId),
    queryFn: () => getJourney(journeyId),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setJourneyEnabled(journeyId, enabled),
    onSuccess: (_res, enabled) => {
      toast({ title: enabled ? "Journey enabled" : "Journey disabled" });
      setConfirmToggle(false);
      void queryClient.invalidateQueries({ queryKey: qk.journey(journeyId) });
      void queryClient.invalidateQueries({ queryKey: qk.journeys });
      void queryClient.invalidateQueries({ queryKey: qk.journeyMetrics });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Update failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setConfirmToggle(false);
    },
  });

  const journey = query.data?.journey;

  return (
    <div className="space-y-6">
      <Link
        to="/journeys"
        className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
      >
        <ArrowLeft className="h-4 w-4" />
        Journeys
      </Link>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !journey ? null : (
        <>
          <PageHeader
            title={journey.name}
            description={journey.id}
            action={
              <Button
                variant={journey.enabled ? "outline" : "default"}
                size="sm"
                onClick={() => setConfirmToggle(true)}
              >
                {journey.enabled ? "Disable" : "Enable"}
              </Button>
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={journey.enabled ? "default" : "secondary"}>
              {journey.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <span className="text-sm text-white/50">
              trigger{" "}
              <code className="font-mono text-accent">
                {journey.trigger.event}
              </code>
            </span>
          </div>

          {/* Compact Definition + Funnel strip — the flow below is the
              centrepiece, so these stay small. */}
          <div className="grid gap-4 lg:grid-cols-2">
            <JourneyMetaCard journey={journey} />
            <Card>
              <CardHeader>
                <CardTitle>Funnel</CardTitle>
              </CardHeader>
              <CardContent>
                <JourneyFunnel journeyId={journeyId} />
              </CardContent>
            </Card>
          </div>

          {/* The visual workflow — inline, full-width, the page's focus. */}
          <JourneyFlow journeyId={journeyId} />

          <JourneyEmailsCard journeyId={journeyId} />
          <JourneyStatesBrowser journeyId={journeyId} />

          <ConfirmDialog
            open={confirmToggle}
            onClose={() => setConfirmToggle(false)}
            onConfirm={() => toggle.mutate(!journey.enabled)}
            title={
              journey.enabled ? "Disable this journey?" : "Enable this journey?"
            }
            description={
              journey.enabled
                ? "New events will stop enrolling users into this journey."
                : "New matching events will start enrolling users into this journey."
            }
            confirmLabel={journey.enabled ? "Disable" : "Enable"}
            destructive={journey.enabled}
            loading={toggle.isPending}
          />
        </>
      )}
    </div>
  );
}
