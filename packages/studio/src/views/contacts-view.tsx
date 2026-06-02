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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listContacts, qk } from "@/lib/admin-api";
import { formatRelative } from "@/lib/format";
import { ContactDetailDrawer } from "./contacts/contact-detail-drawer";

export function ContactsView() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const query = useQuery({
    queryKey: qk.contacts(search),
    queryFn: () => listContacts(search || undefined),
    placeholderData: keepPreviousData,
  });

  const contacts = query.data?.contacts ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="Search contacts and review their full activity timeline."
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by email or external ID…"
          className="pl-9"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
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
        <div className="rounded-lg border">
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
                  <TableCell className="font-medium">
                    {contact.email ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {contact.externalId}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
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
