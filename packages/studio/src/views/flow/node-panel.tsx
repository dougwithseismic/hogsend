import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRight,
  CircleDollarSign,
  Filter,
  GitBranch,
  Globe,
  type LucideIcon,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type FlowGraphNode,
  type FlowNodeContact,
  type FlowNodeKind,
  getFlowNodeContacts,
  qk,
} from "@/lib/admin-api";
import { formatCurrency, formatDuration, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ContactDetailDrawer } from "@/views/contacts/contact-detail-drawer";

/**
 * The drill-down (P5) — WHO is at a node. Rendered OUTSIDE the React Flow tree
 * (in the resizable side panel), so selecting a node never re-mints an
 * edge/node object or restarts a particle animation.
 *
 * The node's own stats come from the ALREADY-LOADED map node (no refetch for
 * what the canvas already knows); the contact list is the one thing the map
 * can't hold, fetched on demand from
 * `GET /v1/admin/flow/nodes/{id}/contacts`. Journey nodes also carry a live
 * enrollment strip + a deep-link into the existing journey graph.
 */

const KIND_ICON: Record<FlowNodeKind, LucideIcon> = {
  surface: Globe,
  journey: GitBranch,
  funnelStage: Filter,
  builtin: CircleDollarSign,
};

const KIND_LABEL: Record<FlowNodeKind, string> = {
  surface: "Surface",
  journey: "Journey",
  funnelStage: "Funnel stage",
  builtin: "Revenue",
};

const TIER_LABEL: Record<NonNullable<FlowGraphNode["tier"]>, string> = {
  acquisition: "Acquisition",
  activation: "Activation",
  retention: "Retention",
  revenue: "Revenue",
};

const JOURNEY_PREFIX = "journey:";

/** The journey id behind a journey node id (null for any other node). */
function journeyIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(JOURNEY_PREFIX)
    ? nodeId.slice(JOURNEY_PREFIX.length)
    : null;
}

/**
 * The money to show for the node, mirroring the card: attributed (the ledger's
 * causal credit) when present, else direct (money that landed here). Never the
 * sum — they double-count the same sale. Largest amount when multi-currency.
 */
function primaryMoney(node: FlowGraphNode) {
  const heat = node.heat;
  if (!heat) return null;
  const pool =
    heat.attributedRevenue.length > 0
      ? heat.attributedRevenue
      : heat.directRevenue;
  const top = [...pool].sort(
    (a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency),
  )[0];
  if (!top) return null;
  return {
    ...top,
    attributed: heat.attributedRevenue.length > 0,
    currencies: pool.length,
  };
}

/** A labelled stat tile in the node header. */
function Stat({
  label,
  value,
  accent,
  title,
}: {
  label: string;
  value: string;
  accent?: boolean;
  title?: string;
}) {
  return (
    <div className="rounded border border-hairline-faint bg-white/[0.02] px-2 py-1.5">
      <div className="eyebrow text-[10px] text-white/40">{label}</div>
      <div
        className={cn(
          "font-display text-sm leading-tight",
          accent ? "text-accent" : "text-white/90",
        )}
        title={title}
      >
        {value}
      </div>
    </div>
  );
}

/** One row of the "N enrolled" journey strip. */
function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="font-mono text-[13px] text-white/90">
        {formatNumber(value)}
      </span>
      <span className="text-[10px] text-white/40">{label}</span>
    </div>
  );
}

function ContactRow({
  contact,
  onOpen,
}: {
  contact: FlowNodeContact;
  onOpen: (contactId: string) => void;
}) {
  const openable = contact.contactId !== null;
  return (
    // The row is the SAME person the Contacts page lists — clicking opens the
    // standard contact drawer (a stuck contact is exactly who an operator
    // wants to inspect and act on). Rows without a resolvable contacts row
    // (raw canonical keys) stay inert.
    <button
      type="button"
      disabled={!openable}
      onClick={() => {
        if (contact.contactId !== null) onOpen(contact.contactId);
      }}
      className={cn(
        "flex w-full items-center justify-between gap-2 border-hairline-faint border-b px-1 py-2 text-left last:border-b-0",
        openable && "cursor-pointer hover:bg-white/[0.03]",
      )}
    >
      <span
        className="truncate text-[13px] text-white/80"
        title={contact.email ?? contact.userId}
      >
        {contact.email ?? contact.userId}
      </span>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap font-mono text-[11px]",
          contact.stuck ? "text-accent" : "text-white/40",
        )}
        title={`Last classified event ${formatDuration(
          contact.hoursIdle * 3600,
        )} ago`}
      >
        {formatDuration(contact.hoursIdle * 3600)} idle
      </span>
    </button>
  );
}

/** > 50 rows: virtualize so a busy node doesn't paint hundreds of DOM rows. */
function VirtualContactList({
  contacts,
  onOpen,
}: {
  contacts: FlowNodeContact[];
  onOpen: (contactId: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: contacts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 37,
    getItemKey: (i) => contacts[i]?.userId ?? i,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className="max-h-[420px] overflow-y-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const contact = contacts[vi.index];
          if (!contact) return null;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <ContactRow contact={contact} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function NodePanel({
  node,
  windowDays,
  onClose,
}: {
  node: FlowGraphNode;
  windowDays: number;
  onClose: () => void;
}) {
  const stuck = node.dwell?.stuckContacts ?? 0;
  // Default the toggle ON when there's a pile-up to look at, else off.
  const [stuckOnly, setStuckOnly] = useState(stuck > 0);
  // Clicking a row opens the STANDARD contact drawer (same as Contacts page).
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const journeyId = journeyIdFromNodeId(node.id);
  const money = primaryMoney(node);
  const rate = node.heat?.conversionRate ?? null;
  const Icon = KIND_ICON[node.kind];

  const query = useQuery({
    queryKey: qk.flowNode(node.id, windowDays, stuckOnly),
    queryFn: () =>
      getFlowNodeContacts({
        nodeId: node.id,
        windowDays,
        stuckOnly,
        limit: 200,
      }),
  });

  const contacts = query.data?.contacts ?? [];
  const counts = query.data?.journey?.counts ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-2 border-hairline-faint border-b px-4 py-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow text-[10px] text-white/40">
              {KIND_LABEL[node.kind]}
            </span>
            {node.tier !== undefined ? (
              <span className="rounded-full border border-hairline-faint px-1.5 py-0.5 text-[10px] text-white/50">
                {TIER_LABEL[node.tier]}
              </span>
            ) : null}
          </div>
          <h3
            className="mt-0.5 truncate font-medium text-[15px] text-white/90"
            title={node.name}
          >
            {node.name}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* The node's own stats — from the already-loaded map node. */}
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="Contacts" value={formatNumber(node.contacts)} />
          <Stat label="Events" value={formatNumber(node.events)} />
          {node.live !== null ? (
            <Stat label="Live" value={formatNumber(node.live)} />
          ) : null}
          {node.dwell ? (
            <Stat
              label="Stuck"
              value={formatNumber(stuck)}
              accent={stuck > 0}
              title={`Idle past ${node.dwell.thresholdHours}h`}
            />
          ) : null}
          {rate !== null ? (
            <Stat label="Conv rate" value={`${(rate * 100).toFixed(0)}%`} />
          ) : null}
          {money ? (
            <Stat
              label={money.attributed ? "Attributed" : "Direct"}
              value={formatCurrency(money.amount, money.currency, {
                maximumFractionDigits: 0,
              })}
              title={
                money.currencies > 1
                  ? "Largest of several currencies"
                  : undefined
              }
            />
          ) : null}
        </div>

        {/* Journey enrollment strip + deep-link. */}
        {journeyId ? (
          <div className="mt-4 rounded-md border border-hairline-faint bg-white/[0.015] p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {counts ? (
                <>
                  <CountChip label="active" value={counts.active} />
                  <CountChip label="waiting" value={counts.waiting} />
                  <CountChip label="completed" value={counts.completed} />
                  <CountChip label="failed" value={counts.failed} />
                  <CountChip label="exited" value={counts.exited} />
                </>
              ) : (
                <span className="text-[12px] text-white/40">
                  Loading enrollment…
                </span>
              )}
            </div>
            <Link
              to="/journeys/$journeyId"
              params={{ journeyId }}
              className="mt-2.5 inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              Open journey <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        ) : null}

        {/* Contact list. */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow text-[11px] text-white/40">
              {stuckOnly ? "Stuck contacts" : "Contacts here"}
            </span>
            {node.dwell ? (
              <button
                type="button"
                onClick={() => setStuckOnly((v) => !v)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  stuckOnly
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-hairline-faint text-white/50 hover:border-white/20",
                )}
              >
                Stuck only
              </button>
            ) : null}
          </div>

          {query.isPending ? (
            <p className="py-6 text-center text-[12px] text-white/35">
              Loading…
            </p>
          ) : query.isError ? (
            <div className="py-4 text-center">
              <p className="text-[12px] text-white/50">
                Couldn't load contacts.
              </p>
              <button
                type="button"
                onClick={() => query.refetch()}
                className="mt-1 text-[12px] text-accent hover:underline"
              >
                Retry
              </button>
            </div>
          ) : contacts.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-white/35">
              Nobody here in this window.
            </p>
          ) : contacts.length > 50 ? (
            <VirtualContactList contacts={contacts} onOpen={setOpenContactId} />
          ) : (
            <div>
              {contacts.map((contact) => (
                <ContactRow
                  key={contact.userId}
                  contact={contact}
                  onOpen={setOpenContactId}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ContactDetailDrawer
        contactId={openContactId}
        onClose={() => setOpenContactId(null)}
      />
    </div>
  );
}
