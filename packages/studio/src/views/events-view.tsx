import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { useMemo, useState } from "react";
import { ContactPicker } from "@/components/contact-picker";
import { EventPicker } from "@/components/event-picker";
import { PropertyTable } from "@/components/property-table";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type EventListFilters,
  type EventListItem,
  getContact,
  listEventNames,
  listEvents,
  listJourneys,
  qk,
} from "@/lib/admin-api";
import { formatDateTime, formatRelative, truncate } from "@/lib/format";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

const PAGE_SIZE = 25;
const LIVE_INTERVAL_MS = 4000;
/** Common engine-stamped origins for the Source filter suggestions; merged with
 * whatever sources actually appear in the loaded events so it never drifts. */
const KNOWN_SOURCES = [
  "posthog",
  "api",
  "studio",
  "connector",
  "journey",
  "import",
];

type TimeWindow = "all" | "1h" | "24h" | "7d";

const WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

type Filters = {
  event: string;
  userId: string;
  source: string;
  window: TimeWindow;
};
const EMPTY_FILTERS: Filters = {
  event: "",
  userId: "",
  source: "",
  window: "24h",
};

/** Compact inline preview of an event's properties for the table cell. */
function propsPreview(p: Record<string, unknown> | null): string {
  if (!p) return "—";
  const entries = Object.entries(p);
  if (entries.length === 0) return "—";
  return entries
    .slice(0, 4)
    .map(
      ([k, v]) =>
        `${k}=${v !== null && typeof v === "object" ? "{…}" : String(v)}`,
    )
    .join(" · ");
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
      {children}
    </h4>
  );
}

function EventDetailDrawer({
  event,
  onClose,
}: {
  event: EventListItem | null;
  onClose: () => void;
}) {
  const contactQuery = useQuery({
    queryKey: event?.contactId
      ? qk.contact(event.contactId)
      : ["contact", "none"],
    queryFn: () => getContact(event?.contactId as string),
    enabled: event?.contactId != null,
  });

  return (
    <Drawer
      open={event !== null}
      onClose={onClose}
      title={event?.event ?? "Event"}
      description={
        event
          ? `${event.source ?? "unknown source"} · ${formatDateTime(event.occurredAt)}`
          : undefined
      }
    >
      {event === null ? null : (
        <div className="space-y-5">
          <div className="space-y-1">
            <SectionHeading>Person</SectionHeading>
            <p className="text-sm text-white/90">
              {event.userEmail ?? event.userId}
            </p>
            {event.userEmail ? (
              <p className="font-mono text-xs text-white/40">{event.userId}</p>
            ) : null}
          </div>

          <section className="space-y-2">
            <SectionHeading>Event properties</SectionHeading>
            <PropertyTable
              properties={event.properties}
              emptyLabel="This event has no properties."
            />
          </section>

          {event.contactId ? (
            <section className="space-y-2">
              <SectionHeading>Person properties</SectionHeading>
              {contactQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : contactQuery.isError ? (
                <p className="text-sm text-white/40">Couldn't load contact.</p>
              ) : (
                <PropertyTable
                  properties={contactQuery.data?.contact.properties}
                  emptyLabel="No person properties set."
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

export function EventsView() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<EventListItem | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null,
  );

  // Recompute the window start only when the window changes (stable query key).
  const fromIso = useMemo(() => {
    if (filters.window === "all") return undefined;
    return new Date(Date.now() - WINDOW_MS[filters.window]).toISOString();
  }, [filters.window]);

  const apiFilters: EventListFilters = {
    limit: PAGE_SIZE,
    offset,
    event: filters.event || undefined,
    userId: filters.userId || undefined,
    source: filters.source || undefined,
    from: fromIso,
  };

  const query = useQuery({
    queryKey: qk.events(apiFilters),
    queryFn: () => listEvents(apiFilters),
    placeholderData: keepPreviousData,
    // Only auto-refresh the head of the feed — polling a fixed offset > 0 would
    // shift the window under the user as new events land at the top.
    refetchInterval: live && offset === 0 ? LIVE_INTERVAL_MS : false,
  });

  // The full observed + declared vocabulary powers the event filter picker;
  // journeys resolve its `usedBy` chips. Both cached for a minute.
  const journeysQuery = useQuery({
    queryKey: qk.journeys,
    queryFn: listJourneys,
    staleTime: 60_000,
  });
  const eventNamesQuery = useQuery({
    queryKey: qk.eventNames,
    queryFn: listEventNames,
    staleTime: 60_000,
  });
  const journeyItems = (journeysQuery.data?.journeys ?? []).map((j) => ({
    id: j.id,
    name: j.name,
  }));

  // Source suggestions: the known origins + any sources actually present in the
  // loaded events, so a new/dynamic source (a webhook id, a connector platform)
  // still shows up as a filter hint.
  const sourceNames = useMemo(() => {
    const set = new Set<string>(KNOWN_SOURCES);
    for (const ev of query.data?.events ?? []) {
      if (ev.source) set.add(ev.source);
    }
    return Array.from(set).sort();
  }, [query.data?.events]);

  function patch(next: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...next }));
    setOffset(0);
  }

  const hasFilters =
    Boolean(filters.event) ||
    Boolean(filters.userId) ||
    Boolean(filters.source) ||
    filters.window !== EMPTY_FILTERS.window;
  const total = query.data?.total ?? 0;
  const events = query.data?.events ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        description="Every event ingested into the pipeline — who it's from, and its properties."
        action={
          <Button
            variant={live ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setLive((v) => !v);
              setOffset(0);
            }}
            title="Auto-refresh the feed"
          >
            <Radio className="h-4 w-4" />
            {live ? "Live" : "Go live"}
          </Button>
        }
      />

      <div className="grid gap-3 rounded-lg border bg-white/[0.015] p-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Event</Label>
          <EventPicker
            ariaLabel="Event"
            value={filters.event}
            placeholder="All events"
            events={eventNamesQuery.data?.events ?? []}
            journeys={journeyItems}
            onChange={(event) => patch({ event })}
            allowClear
            allowCustom
          />
        </div>
        <div className="space-y-1.5">
          <Label>Source</Label>
          <Combobox
            ariaLabel="Source"
            value={filters.source}
            placeholder="All sources"
            options={sourceNames.map((s) => ({ value: s, label: s }))}
            onChange={(source) => patch({ source })}
            allowClear
            allowCustom
          />
        </div>
        <div className="space-y-1.5">
          <Label>Person</Label>
          <ContactPicker
            ariaLabel="Person"
            value={filters.userId}
            placeholder="All people"
            onChange={(userId) => patch({ userId })}
            allowClear
            allowCustom
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-window">Time range</Label>
          <Select
            id="f-window"
            value={filters.window}
            onChange={(e) => patch({ window: e.target.value as TimeWindow })}
          >
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="all">All time</option>
          </Select>
        </div>
        {hasFilters ? (
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setOffset(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No events found"
          description={
            hasFilters
              ? "Try widening the time range or clearing filters."
              : "Events appear here as they're ingested. Fire one from the Fire event button."
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Person</TableHead>
                <TableHead>Properties</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((ev) => (
                <TableRow
                  key={ev.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(ev)}
                >
                  <TableCell className="font-mono text-xs text-white">
                    {ev.event}
                  </TableCell>
                  <TableCell>
                    {ev.source ? (
                      <Badge variant="outline">{ev.source}</Badge>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {ev.contactId ? (
                      <button
                        type="button"
                        className="text-left text-white/80 hover:text-white hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Close the event drawer first so the two drawers
                          // never stack (each owns a global Escape listener).
                          setSelected(null);
                          setSelectedContactId(ev.contactId);
                        }}
                        title="View this person"
                      >
                        {ev.userEmail ?? ev.userId}
                      </button>
                    ) : (
                      <span className="text-white/80">
                        {ev.userEmail ?? ev.userId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-white/50">
                    {truncate(propsPreview(ev.properties), 56)}
                  </TableCell>
                  <TableCell
                    className="text-white/60"
                    title={formatDateTime(ev.occurredAt)}
                  >
                    {formatRelative(ev.occurredAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between text-sm text-white/60">
          <span>
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <EventDetailDrawer event={selected} onClose={() => setSelected(null)} />
      <ContactDetailDrawer
        contactId={selectedContactId}
        onClose={() => setSelectedContactId(null)}
      />
    </div>
  );
}
