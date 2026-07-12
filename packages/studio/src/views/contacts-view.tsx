import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
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

export function ContactsView() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minRevenueInput, setMinRevenueInput] = useState("");
  const [minRevenue, setMinRevenue] = useState<number | undefined>(undefined);
  const [dealStage, setDealStage] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The deployment's configured pipeline ladder drives the stage options.
  const statsQuery = useQuery({
    queryKey: qk.dealsStats,
    queryFn: getDealsStats,
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
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchInput, minRevenueInput]);

  const filters = {
    search: search || undefined,
    minRevenue,
    dealStage: dealStage || undefined,
  };
  const query = useQuery({
    queryKey: qk.contacts(filters),
    queryFn: () => listContacts(filters),
    placeholderData: keepPreviousData,
  });

  const contacts = query.data?.contacts ?? [];

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
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : contacts.length === 0 ? (
        <EmptyState
          title="No contacts found"
          description={
            search
              ? "No contacts match your search."
              : "Contacts appear here as events are ingested."
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>External ID</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
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
                  <TableCell className="text-right text-white/60">
                    {formatRelative(contact.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
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
