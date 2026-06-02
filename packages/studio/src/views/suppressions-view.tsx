import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
  listSuppressions,
  qk,
  type Suppression,
  updateContactPreferences,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

const TYPES = [
  { value: "", label: "All" },
  { value: "bounced", label: "Bounced" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "complained", label: "Complained" },
];

function SuppressionTags({ row }: { row: Suppression }) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.unsubscribedAll ? (
        <Badge variant="destructive">Unsubscribed</Badge>
      ) : null}
      {row.bounceCount > 0 ? (
        <Badge variant="secondary">
          {formatNumber(row.bounceCount)} bounce
        </Badge>
      ) : null}
      {row.suppressed && row.bounceCount === 0 && !row.unsubscribedAll ? (
        <Badge variant="destructive">Complained</Badge>
      ) : null}
      {row.suppressed && !row.unsubscribedAll && row.bounceCount > 0 ? (
        <Badge variant="destructive">Suppressed</Badge>
      ) : null}
    </div>
  );
}

export function SuppressionsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [type, setType] = useState("");
  const [target, setTarget] = useState<Suppression | null>(null);

  const query = useQuery({
    queryKey: qk.suppressions(type),
    queryFn: () => listSuppressions(type || undefined),
    placeholderData: keepPreviousData,
  });

  const unsuppress = useMutation({
    // The preferences route resolves a contact by id OR externalId; the
    // suppression's userId is the contact externalId.
    mutationFn: (row: Suppression) =>
      updateContactPreferences(row.userId, {
        suppressed: false,
        unsubscribedAll: false,
      }),
    onSuccess: () => {
      toast({
        title: "Recipient restored",
        description: "They can receive emails again.",
      });
      setTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Un-suppress failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setTarget(null);
    },
  });

  const rows = query.data?.suppressions ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppressions"
        description="Bounced, unsubscribed, and complained recipients."
      />

      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="supp-type">Type</Label>
        <Select
          id="supp-type"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No suppressions"
          description="Recipients who bounce, unsubscribe, or complain appear here."
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>User ID</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Suppressed</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.email}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.userId}
                  </TableCell>
                  <TableCell>
                    <SuppressionTags row={row} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDateTime(row.suppressedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTarget(row)}
                    >
                      Un-suppress
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        onConfirm={() => target && unsuppress.mutate(target)}
        title="Un-suppress this recipient?"
        description={
          target
            ? `${target.email} will be eligible to receive emails again.`
            : undefined
        }
        confirmLabel="Un-suppress"
        loading={unsuppress.isPending}
      />
    </div>
  );
}
