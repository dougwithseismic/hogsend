import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SplitButton, type SplitItem } from "@/components/ui/split-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getLink, type Link, linkQrUrl, qk, updateLink } from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber, truncate } from "@/lib/format";
import { isHttpUrl } from "@/lib/url";

// QR export formats — served straight off the admin endpoint (no client-side
// rendering), downloaded via a synthesized <a download>.
const QR_EXPORT_ITEMS = [
  { id: "png", label: "PNG" },
  { id: "png-transparent", label: "PNG (transparent)" },
  { id: "svg", label: "SVG" },
] as const satisfies readonly SplitItem<string>[];
type QrExportFormat = (typeof QR_EXPORT_ITEMS)[number]["id"];
const QR_EXPORT_STORAGE_KEY = "hs.studio.qr-export";

function downloadQr(link: Link, id: QrExportFormat) {
  const transparent = id === "png-transparent";
  const format = id === "svg" ? ("svg" as const) : ("png" as const);
  const a = document.createElement("a");
  a.href = linkQrUrl(link.id, {
    format,
    size: format === "png" ? 1024 : 512,
    transparent,
  });
  a.download = `${link.slug ?? link.id}-qr${
    transparent ? "-transparent" : ""
  }.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * The QR dialog shared by the Links and QR codes views: live preview (the
 * <img> hits the admin endpoint, which lazy-mints the scan row on first
 * render), export split-button, inline re-target, and the per-destination
 * stats breakdown from `GET /:id`.
 */
export function QrLinkDialog({
  link,
  onClose,
}: {
  link: Link | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Inline re-target field, pre-filled per link.
  const [destination, setDestination] = useState("");
  useEffect(() => {
    setDestination(link?.originalUrl ?? "");
  }, [link]);

  // Live detail while open — scan counts + destination buckets stay fresh
  // (`GET /:id` is cheap and the dialog is the read surface for both).
  const detail = useQuery({
    queryKey: qk.link(link?.id ?? ""),
    queryFn: () => getLink(link?.id ?? ""),
    enabled: link !== null,
  });

  const destinationValid = isHttpUrl(destination.trim());
  const destinationDirty =
    link !== null && destination.trim() !== link.originalUrl;

  const retarget = useMutation({
    mutationFn: () => {
      if (!link) throw new Error("No link selected.");
      return updateLink(link.id, { originalUrl: destination.trim() });
    },
    onSuccess: () => {
      toast({ title: "Destination updated" });
      void queryClient.invalidateQueries({ queryKey: ["links"] });
      if (link) {
        void queryClient.invalidateQueries({ queryKey: qk.link(link.id) });
      }
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Could not re-target",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const destinations = detail.data?.destinations ?? [];
  const scanCount = detail.data?.scanCount ?? link?.scanCount ?? 0;

  return (
    <Dialog
      open={link !== null}
      onClose={onClose}
      title="QR code"
      description="Encodes the durable short URL — never the vanity slug — so printed codes survive edits and re-targeting."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {link ? (
        <div className="space-y-4">
          <div className="flex justify-center rounded-md border border-hairline-faint bg-white p-4">
            <img
              src={linkQrUrl(link.id, { format: "svg", size: 512 })}
              alt={`QR code for ${link.label ?? link.originalUrl}`}
              className="h-56 w-56"
              crossOrigin="use-credentials"
            />
          </div>

          {link.description ? (
            <p className="text-white/70 text-xs">{link.description}</p>
          ) : null}

          <p className="text-white/60 text-xs">
            {formatNumber(scanCount)} scan{scanCount === 1 ? "" : "s"} recorded.
            Scans are counted separately from link clicks; re-targeting below
            updates where the printed code leads.
          </p>

          {/* Landing-confirmed arrivals — the known-contact story. Shown once
              the link participates (appendRef) or any arrival exists. */}
          {(detail.data?.arrivalCount ?? 0) > 0 || link.appendRef ? (
            <p className="text-white/60 text-xs">
              {formatNumber(detail.data?.arrivalCount ?? 0)} confirmed arrival
              {(detail.data?.arrivalCount ?? 0) === 1 ? "" : "s"} ·{" "}
              <span
                className={
                  (detail.data?.identifiedArrivalCount ?? 0) > 0
                    ? "text-accent"
                    : undefined
                }
              >
                {formatNumber(detail.data?.identifiedArrivalCount ?? 0)} from
                known contact
                {(detail.data?.identifiedArrivalCount ?? 0) === 1 ? "" : "s"}
              </span>
              {link.appendRef
                ? ""
                : " — enable “Append arrival ref” to capture more"}
            </p>
          ) : null}

          <SplitButton<QrExportFormat>
            items={QR_EXPORT_ITEMS}
            storageKey={QR_EXPORT_STORAGE_KEY}
            defaultId="png"
            onAct={(id) => downloadQr(link, id)}
            renderLabel={(item) => `Download ${item.label}`}
            caretLabel="Choose a QR export format"
            primaryIcon={{ Icon: Download }}
          />

          {/* Inline re-target — the print-marketing move: the code on the door
              stays, where it leads changes. */}
          <div className="space-y-1.5">
            <Label htmlFor="qr-destination">Destination</Label>
            <div className="flex items-center gap-2">
              <Input
                id="qr-destination"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="https://hogsend.com/pricing"
              />
              <Button
                variant="outline"
                onClick={() => retarget.mutate()}
                disabled={
                  !destinationDirty || !destinationValid || retarget.isPending
                }
              >
                {retarget.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
            {destination.trim() && !destinationValid ? (
              <p className="text-accent text-xs">
                Must be a valid http(s) URL.
              </p>
            ) : destinationDirty ? (
              <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent-tint p-2.5 text-accent text-xs">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Every already-printed/shared copy of this code redirects to
                  the new destination on its next scan.
                </span>
              </div>
            ) : null}
          </div>

          {/* Per-destination stats — which destination was live when each hit
              landed. Hidden until there is more than one bucket to compare. */}
          {destinations.length > 1 ? (
            <div className="space-y-1.5">
              <Label>Stats per destination</Label>
              <div className="rounded-md border border-hairline-faint">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Destination</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">Scans</TableHead>
                      <TableHead>Last hit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {destinations.map((d) => (
                      <TableRow key={d.url ?? "__pre-provenance__"}>
                        <TableCell
                          className="text-white/80 text-xs"
                          title={d.url ?? undefined}
                        >
                          {d.url ? truncate(d.url, 42) : "before tracking"}
                        </TableCell>
                        <TableCell className="text-right text-white/80">
                          {formatNumber(d.clicks)}
                        </TableCell>
                        <TableCell className="text-right text-white/80">
                          {formatNumber(d.scans)}
                        </TableCell>
                        <TableCell className="text-white/60 text-xs">
                          {formatDateTime(d.lastAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
