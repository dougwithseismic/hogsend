import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, QrCode } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  createLink,
  type Link,
  linkQrUrl,
  listLinks,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber, truncate } from "@/lib/format";
import { QrLinkDialog } from "./links/qr-dialog";

/** http(s)-only guard, mirroring the engine's open-redirect check in mintLink. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * QR-first lens over the managed-links spine: a "QR code" IS a managed link
 * whose QR scan row exists (`hasQr=true`). Creating one mints a link, then
 * touches the QR endpoint so the scan row exists immediately (membership is
 * row-existence, not "has been scanned") and opens the QR dialog for
 * download/print.
 */
export function QrCodesView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [qrTarget, setQrTarget] = useState<Link | null>(null);

  // Create-form fields.
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");

  const query = useQuery({
    queryKey: qk.qrCodes(),
    queryFn: () => listLinks({ hasQr: true }),
  });

  function resetForm() {
    setUrl("");
    setLabel("");
    setDescription("");
  }

  const urlValid = isHttpUrl(url.trim());
  const canSubmit = urlValid && label.trim().length > 0;

  const create = useMutation({
    mutationFn: async () => {
      const link = await createLink({
        url: url.trim(),
        label: label.trim(),
        type: "public",
        description: description.trim() || undefined,
      });
      // Touch the QR endpoint so the scan row exists NOW — this is what makes
      // the new link a member of the hasQr lens (and warms the preview).
      await fetch(linkQrUrl(link.id), { credentials: "include" });
      return link;
    },
    onSuccess: (link) => {
      setCreateOpen(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ["links"] });
      setQrTarget(link);
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Could not create QR code",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const rows = query.data?.links ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="QR codes"
        description="Print-first tracked codes — the printed artifact stays, its destination and stats stay editable."
        action={
          <Button
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New QR code
          </Button>
        }
      />

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={QrCode}
          title="No QR codes yet"
          description="Mint a code, print it anywhere, and re-target its destination later — scans are tracked per destination."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetForm();
                setCreateOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              New QR code
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Scans</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-white">
                    <div className="flex flex-col gap-0.5">
                      <span>{row.label ?? "—"}</span>
                      {row.description ? (
                        <span className="font-normal text-white/40 text-xs">
                          {truncate(row.description, 64)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    className="text-white/70 text-xs"
                    title={row.originalUrl}
                  >
                    {truncate(row.originalUrl, 48)}
                  </TableCell>
                  <TableCell className="text-right text-white/80">
                    {formatNumber(row.scanCount)}
                  </TableCell>
                  <TableCell className="text-right text-white/80">
                    {formatNumber(row.clickCount)}
                  </TableCell>
                  <TableCell className="text-white/60">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setQrTarget(row)}
                    >
                      <QrCode className="h-4 w-4" />
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create dialog — QR-first mint: destination + label + description. */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New QR code"
        description="Mints a tracked link and its QR code. The code encodes a durable URL, so you can re-target the destination after printing."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!canSubmit || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create QR code"}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="qr-url">Destination URL</Label>
          <Input
            id="qr-url"
            placeholder="https://hogsend.com/pricing"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {url.trim() && !urlValid ? (
            <p className="text-accent text-xs">Must be a valid http(s) URL.</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qr-label">Label</Label>
          <Input
            id="qr-label"
            placeholder="Workshop door"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qr-description">Description (optional)</Label>
          <Input
            id="qr-description"
            placeholder="A5 sticker, left door, printed July 2026"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="text-white/40 text-xs">
            What/where this code physically is — for telling codes apart later.
          </p>
        </div>
      </Dialog>

      <QrLinkDialog link={qrTarget} onClose={() => setQrTarget(null)} />
    </div>
  );
}
