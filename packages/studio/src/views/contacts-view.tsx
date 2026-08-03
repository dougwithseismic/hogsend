import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDealsStats, listContacts, qk } from "@/lib/admin-api";
import { formatRelative } from "@/lib/format";
import { DEFAULT_STAGES, stageLabel } from "@/lib/stages";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

export function ContactsView({
  /** Deep-linked contact (`?contact=<uuid>`) whose drawer opens on load. */
  initialContactId = null,
}: {
  initialContactId?: string | null;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minRevenueInput, setMinRevenueInput] = useState("");
  const [minRevenue, setMinRevenue] = useState<number | undefined>(undefined);
  const [dealStage, setDealStage] = useState("");
  // PRD 01 — this screen (and ONLY this screen) opts in to the identified-only
  // view. The server default is `all`, so the CLI and the contact picker are
  // untouched. Flipping this initial value back to "all" is the fastest kill
  // switch if the predicate ever hides someone it shouldn't.
  const [identity, setIdentity] = useState<"identified" | "anonymous" | "all">(
    "identified",
  );
  // PRD 06 leaderboard: a configurable property key ranks the list by that
  // property's NUMERIC value (server-guarded — non-numeric sorts last).
  const [scoreInput, setScoreInput] = useState("");
  const [scoreProperty, setScoreProperty] = useState("");
  const [scoreDir, setScoreDir] = useState<"asc" | "desc">("desc");
  const [selectedId, setSelectedId] = useState<string | null>(initialContactId);

  // The deployment's configured pipeline ladder drives the stage options.
  const statsQuery = useQuery({
    queryKey: qk.dealsStats(),
    queryFn: () => getDealsStats(),
    staleTime: 60_000,
  });
  const dealStageOptions = [
    { value: "", label: "Any deal stage" },
    ...(statsQuery.data?.stageOrder ?? DEFAULT_STAGES).map((s) => ({
      value: s,
      label: `Deal: ${stageLabel(s).toLowerCase()}`,
    })),
  ];

  // Debounce the text filters so we don't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setMinRevenue(minRevenueInput ? Number(minRevenueInput) : undefined);
      setScoreProperty(scoreInput.trim());
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput, minRevenueInput, scoreInput]);

  const filters = {
    search: search || undefined,
    identity,
    minRevenue,
    dealStage: dealStage || undefined,
    // With no score property set, no ordering params are sent — the server
    // behaves exactly as before (lastSeenAt desc).
    ...(scoreProperty
      ? {
          orderBy: "property" as const,
          orderProperty: scoreProperty,
          orderDir: scoreDir,
        }
      : {}),
  };
  const query = useQuery({
    queryKey: qk.contacts(filters),
    queryFn: () => listContacts(filters),
    placeholderData: keepPreviousData,
  });

  const contacts = query.data?.contacts ?? [];

  // Zero rows means something different under each filter value, and saying so
  // is the difference between "the CRM is empty" and "the filter is on".
  const emptyDescription = search
    ? identity === "identified"
      ? "No identified contacts match your search — anonymous visitors are hidden."
      : "No contacts match your search."
    : identity === "identified"
      ? "No contact has identified yet. They appear here once an event asserts an email, user ID, Discord ID or phone."
      : identity === "anonymous"
        ? "Every contact has identified — there is no anonymous tail."
        : "Contacts appear here as events are ingested.";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="Search contacts and review their full activity timeline."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
            strokeWidth={1.5}
          />
          <Input
            placeholder="Search by email or external ID…"
            className="pl-9"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Input
          className="w-40"
          placeholder="Min revenue"
          inputMode="numeric"
          value={minRevenueInput}
          onChange={(e) =>
            setMinRevenueInput(e.target.value.replace(/[^0-9.]/g, ""))
          }
        />
        <div className="w-48">
          <Select
            value={identity}
            onChange={(e) =>
              setIdentity(e.target.value as "identified" | "anonymous" | "all")
            }
            aria-label="Filter by identity"
          >
            <option value="identified">Identified only</option>
            <option value="anonymous">Never identified</option>
            <option value="all">All contacts</option>
          </Select>
        </div>
        <div className="w-48">
          <Select
            value={dealStage}
            onChange={(e) => setDealStage(e.target.value)}
            aria-label="Filter by deal stage"
          >
            {dealStageOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Input
          className="w-48"
          placeholder="Rank by property (e.g. gtmScore)"
          aria-label="Rank by property"
          value={scoreInput}
          onChange={(e) =>
            setScoreInput(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ""))
          }
          maxLength={64}
        />
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : contacts.length === 0 ? (
        <EmptyState
          title="No contacts found"
          description={emptyDescription}
          // The escape hatch. Search ALSO matches `anonymous_id`, so pasting
          // an anon id into the box under the identified-only default returns
          // nothing and looks broken — this widens the same search instead of
          // making the operator hunt for the dropdown.
          action={
            search && identity === "identified" ? (
              <Button variant="secondary" onClick={() => setIdentity("all")}>
                Search all contacts
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>External ID</TableHead>
                {scoreProperty ? (
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 transition-colors duration-200 hover:text-white"
                      onClick={() =>
                        setScoreDir((d) => (d === "desc" ? "asc" : "desc"))
                      }
                    >
                      {scoreProperty}
                      {scoreDir === "asc" ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )}
                    </button>
                  </TableHead>
                ) : null}
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => {
                const score = scoreProperty
                  ? contact.properties?.[scoreProperty]
                  : undefined;
                return (
                  <TableRow
                    key={contact.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(contact.id)}
                  >
                    <TableCell className="font-medium text-white">
                      {contact.email ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-white/70">
                      {contact.externalId}
                    </TableCell>
                    {scoreProperty ? (
                      <TableCell className="text-right font-mono text-xs text-white/70">
                        {/* Only real JSON numbers rank (the server's type
                            guard); anything else sits in the unscored tail. */}
                        {typeof score === "number" ? score : "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right text-white/60">
                      {formatRelative(contact.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ContactDetailDrawer
        contactId={selectedId}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
