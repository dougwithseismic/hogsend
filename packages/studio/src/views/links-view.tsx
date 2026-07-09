import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  Copy,
  Download,
  Link2,
  Pencil,
  Plus,
  QrCode,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  archiveLink,
  type CreatedLink,
  createLink,
  type Link,
  linkQrUrl,
  listLinks,
  qk,
  updateLink,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatNumber, truncate } from "@/lib/format";

const TYPES = [
  { value: "", label: "All" },
  { value: "public", label: "Public" },
  { value: "personal", label: "Personal" },
];

type LinkType = "personal" | "public";

/** http(s)-only guard, mirroring the engine's open-redirect check in mintLink. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Mirrors the engine's normalizeSlug: 1-64 lowercase [a-z0-9-], no
// leading/trailing hyphen. Input is lowercased before the check, so typing
// "Black-Friday" is fine — it mints as "black-friday".
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function normalizeSlugInput(value: string): string {
  return value.trim().toLowerCase();
}

/** Empty = "no slug", always valid; anything else must match the engine rule. */
function isSlugValid(value: string): boolean {
  const slug = normalizeSlugInput(value);
  return slug === "" || SLUG_RE.test(slug);
}

/** True when the failed mutation was a slug-uniqueness conflict (HTTP 409). */
function isSlugConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

const SLUG_INVALID_HINT =
  "1–64 letters, digits or hyphens — no leading/trailing hyphen.";
const SLUG_DEFAULT_HINT = "A memorable /l/… path over the tracked short URL.";

/**
 * The vanity-slug field shared by the create + edit dialogs: Label + Input +
 * the invalid-shape message. `hint` is the dialog-specific message shown while
 * the input is empty or valid (create shows a /l/… preview; edit warns when
 * clearing).
 */
function SlugField({
  id,
  value,
  valid,
  onChange,
  hint,
}: {
  id: string;
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
  hint: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Vanity slug (optional)</Label>
      <Input
        id={id}
        placeholder="black-friday"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() && !valid ? (
        <p className="text-accent text-xs">{SLUG_INVALID_HINT}</p>
      ) : (
        hint
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: LinkType }) {
  return type === "personal" ? (
    <Badge variant="destructive">Personal</Badge>
  ) : (
    <Badge variant="secondary">Public</Badge>
  );
}

export function LinksView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [type, setType] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Link | null>(null);
  const [editTarget, setEditTarget] = useState<Link | null>(null);
  const [qrTarget, setQrTarget] = useState<Link | null>(null);

  // Create-form fields.
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [campaign, setCampaign] = useState("");
  const [slug, setSlug] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("public");
  const [distinctId, setDistinctId] = useState("");

  // Edit-form fields (separate from the create form so the two dialogs never
  // share state). Pre-filled from the target row on open.
  const [editUrl, setEditUrl] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editCampaign, setEditCampaign] = useState("");
  const [editSlug, setEditSlug] = useState("");

  const query = useQuery({
    queryKey: qk.links(type),
    queryFn: () => listLinks(type ? { type: type as LinkType } : undefined),
    placeholderData: keepPreviousData,
  });

  function resetForm() {
    setUrl("");
    setLabel("");
    setCampaign("");
    setSlug("");
    setLinkType("public");
    setDistinctId("");
  }

  function openEdit(row: Link) {
    setEditTarget(row);
    setEditUrl(row.originalUrl);
    setEditLabel(row.label ?? "");
    setEditCampaign(row.campaign ?? "");
    setEditSlug(row.slug ?? "");
  }

  const urlValid = isHttpUrl(url.trim());
  const slugValid = isSlugValid(slug);
  const canSubmit = urlValid && slugValid && label.trim().length > 0;

  const editUrlValid = isHttpUrl(editUrl.trim());
  const editSlugValid = isSlugValid(editSlug);
  const canSaveEdit =
    editUrlValid && editSlugValid && editLabel.trim().length > 0;

  const create = useMutation({
    mutationFn: () =>
      createLink({
        url: url.trim(),
        label: label.trim(),
        type: linkType,
        campaign: campaign.trim() || undefined,
        slug: normalizeSlugInput(slug) || undefined,
        // Share-safe invariant: identity only travels on personal links. The
        // engine drops distinctId for public links too, but we don't even send
        // it — keeps the wire honest.
        distinctId:
          linkType === "personal" && distinctId.trim()
            ? distinctId.trim()
            : undefined,
      }),
    onSuccess: (res) => {
      setCreateOpen(false);
      resetForm();
      setCreated(res);
      void queryClient.invalidateQueries({ queryKey: ["links"] });
    },
    onError: (error) => mutationErrorToast(error, "Could not create link"),
  });

  const update = useMutation({
    mutationFn: () => {
      // Guard rather than assert: the dialog only opens with a target, but this
      // narrows editTarget to a non-null Link so updateLink gets a real string
      // id (its first arg is `string`, not `string | undefined`).
      if (!editTarget) throw new Error("No link selected to edit.");
      // Only send `slug` when it actually changed: emptied = clear (null),
      // otherwise set/replace. Sending an unchanged slug would be a no-op
      // anyway, but omitting keeps the wire minimal.
      const nextSlug = normalizeSlugInput(editSlug);
      const prevSlug = editTarget.slug ?? "";
      return updateLink(editTarget.id, {
        originalUrl: editUrl.trim(),
        label: editLabel.trim(),
        campaign: editCampaign.trim() || undefined,
        ...(nextSlug !== prevSlug ? { slug: nextSlug || null } : {}),
      });
    },
    onSuccess: () => {
      const id = editTarget?.id;
      toast({ title: "Link updated" });
      setEditTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["links"] });
      // The detail query (getLink) caches originalUrl too — refresh it so an
      // open detail view doesn't show the stale destination after re-target.
      if (id) {
        void queryClient.invalidateQueries({ queryKey: qk.link(id) });
      }
    },
    onError: (error) => mutationErrorToast(error, "Could not update link"),
  });

  const archive = useMutation({
    mutationFn: (id: string) => archiveLink(id),
    onSuccess: () => {
      toast({ title: "Link archived" });
      setArchiveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["links"] });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Archive failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setArchiveTarget(null);
    },
  });

  // Shared error toast for the create/update mutations: a 409 is always the
  // slug-uniqueness conflict on this surface.
  function mutationErrorToast(error: unknown, fallbackTitle: string) {
    toast({
      variant: "error",
      title: isSlugConflict(error) ? "Slug already taken" : fallbackTitle,
      description:
        error instanceof ApiError ? error.message : "Unexpected error.",
    });
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ variant: "error", title: "Copy failed" });
    }
  }

  const rows = query.data?.links ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Links"
        description="First-party tracked short links — minted outside email, click-tracked the same way."
        action={
          <Button
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New link
          </Button>
        }
      />

      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="link-type-filter">Type</Label>
        <Select
          id="link-type-filter"
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
          icon={Link2}
          title="No links yet"
          description="Mint a tracked short link to share anywhere — every click is recorded."
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
              New link
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">Scans</TableHead>
                <TableHead>Short link</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                // The engine returns an authoritative short `url` per row (built
                // from API_PUBLIC_URL with the correct tracked-link id). Show the
                // compact path; copy the full URL.
                const shortUrl = row.url;
                const shortPath = shortUrl.replace(/^https?:\/\/[^/]+/, "");
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-white">
                      <div className="flex flex-col gap-0.5">
                        <span>{row.label ?? "—"}</span>
                        <span className="font-normal text-white/40 text-xs">
                          {truncate(row.originalUrl, 56)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={row.type} />
                    </TableCell>
                    <TableCell className="text-white/70">
                      {row.campaign ?? "—"}
                    </TableCell>
                    <TableCell>
                      {row.source ? (
                        <Badge variant="outline">{row.source}</Badge>
                      ) : (
                        <span className="text-white/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-white/80">
                      {formatNumber(row.clickCount)}
                    </TableCell>
                    <TableCell className="text-right text-white/80">
                      {formatNumber(row.scanCount)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {row.vanityUrl ? (
                          <div className="flex items-center gap-1.5">
                            <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white text-xs">
                              /l/{row.slug}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() =>
                                row.vanityUrl && copy(row.vanityUrl)
                              }
                              aria-label="Copy vanity link"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : null}
                        <div className="flex items-center gap-1.5">
                          <code className="rounded border border-hairline-faint bg-white/[0.04] px-1.5 py-0.5 font-mono text-white/70 text-xs">
                            {truncate(shortPath, 28)}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => copy(shortUrl)}
                            aria-label="Copy short link"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-white/60">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setQrTarget(row)}
                          aria-label="Show QR code"
                        >
                          <QrCode className="h-4 w-4" />
                          QR
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEdit(row)}
                        >
                          <Pencil className="h-4 w-4" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setArchiveTarget(row)}
                        >
                          Archive
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New tracked link"
        description="Mint a first-party short link. Clicks are recorded the same way as email links."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!canSubmit || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create link"}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="link-url">Destination URL</Label>
          <Input
            id="link-url"
            placeholder="https://hogsend.com/pricing"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {url.trim() && !urlValid ? (
            <p className="text-accent text-xs">Must be a valid http(s) URL.</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-label">Label</Label>
          <Input
            id="link-label"
            placeholder="Pricing CTA — June launch"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <SlugField
          id="link-slug"
          value={slug}
          valid={slugValid}
          onChange={setSlug}
          hint={
            slug.trim() ? (
              <p className="text-white/40 text-xs">
                Short path: /l/{normalizeSlugInput(slug)} — must be unique.
              </p>
            ) : (
              <p className="text-white/40 text-xs">{SLUG_DEFAULT_HINT}</p>
            )
          }
        />

        <div className="space-y-1.5">
          <Label htmlFor="link-campaign">Campaign (optional)</Label>
          <Input
            id="link-campaign"
            placeholder="june-launch"
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="link-type">Type</Label>
          <Select
            id="link-type"
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as LinkType)}
          >
            <option value="public">Public — safe to share anywhere</option>
            <option value="personal">Personal — single recipient</option>
          </Select>
        </div>

        {linkType === "personal" ? (
          <>
            <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent-tint p-3 text-accent text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Single-recipient only — do not share. A personal link carries an
                identity token, so a forwarded link would attribute the wrong
                person.
              </span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-distinct-id">
                Recipient distinct ID (optional)
              </Label>
              <Input
                id="link-distinct-id"
                placeholder="user_123 or email"
                value={distinctId}
                onChange={(e) => setDistinctId(e.target.value)}
              />
              <p className="text-white/40 text-xs">
                Attaches this link's clicks to a known person. Ignored for
                public links.
              </p>
            </div>
          </>
        ) : null}
      </Dialog>

      {/* Edit dialog — re-target destination + relabel a managed link. */}
      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit link"
        description="Change where this managed short link points, or relabel it."
        footer={
          <>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => update.mutate()}
              disabled={!canSaveEdit || update.isPending}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="edit-link-url">Destination URL</Label>
          <Input
            id="edit-link-url"
            placeholder="https://hogsend.com/pricing"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
          />
          {editUrl.trim() && !editUrlValid ? (
            <p className="text-accent text-xs">Must be a valid http(s) URL.</p>
          ) : null}
        </div>

        {editTarget && editUrl.trim() !== editTarget.originalUrl ? (
          <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent-tint p-3 text-accent text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Changing the destination redirects the already-distributed short
              link — the next click on the same short URL goes to the new
              target.
            </span>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="edit-link-label">Label</Label>
          <Input
            id="edit-link-label"
            placeholder="Pricing CTA — June launch"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
          />
        </div>

        <SlugField
          id="edit-link-slug"
          value={editSlug}
          valid={editSlugValid}
          onChange={setEditSlug}
          hint={
            editTarget?.slug && !editSlug.trim() ? (
              <p className="text-accent text-xs">
                Clearing frees /l/{editTarget.slug} — the vanity URL stops
                resolving (the UUID short link keeps working).
              </p>
            ) : (
              <p className="text-white/40 text-xs">{SLUG_DEFAULT_HINT}</p>
            )
          }
        />

        <div className="space-y-1.5">
          <Label htmlFor="edit-link-campaign">Campaign (optional)</Label>
          <Input
            id="edit-link-campaign"
            placeholder="june-launch"
            value={editCampaign}
            onChange={(e) => setEditCampaign(e.target.value)}
          />
        </div>
      </Dialog>

      {/* Minted-link reveal */}
      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Link created"
        description="Share this short URL — every click is tracked first-party."
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}
      >
        {created ? (
          <div className="space-y-3">
            {created.vanityUrl ? (
              <div className="space-y-1.5">
                <Label>Vanity URL</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-white text-xs">
                    {created.vanityUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => created.vanityUrl && copy(created.vanityUrl)}
                    aria-label="Copy vanity URL"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Short URL</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-white/90 text-xs">
                  {created.url}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copy(created.url)}
                  aria-label="Copy short URL"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {created.type === "personal" ? (
              <div className="flex items-start gap-2 rounded-md border border-accent/40 bg-accent-tint p-3 text-accent text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  This is a personal link — send it to one recipient only. Do
                  not post it publicly.
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {/* QR dialog — live preview + downloads. The image URL is the admin QR
          endpoint itself (session cookie rides along); first render lazy-mints
          the link's scan row. */}
      <Dialog
        open={qrTarget !== null}
        onClose={() => setQrTarget(null)}
        title="QR code"
        description="Encodes the durable short URL — never the vanity slug — so printed codes survive edits and re-targeting."
        footer={<Button onClick={() => setQrTarget(null)}>Done</Button>}
      >
        {qrTarget ? (
          <div className="space-y-3">
            <div className="flex justify-center rounded-md border border-hairline-faint bg-white p-4">
              <img
                src={linkQrUrl(qrTarget.id, { format: "svg", size: 512 })}
                alt={`QR code for ${qrTarget.label ?? qrTarget.originalUrl}`}
                className="h-56 w-56"
                crossOrigin="use-credentials"
              />
            </div>
            <p className="text-white/60 text-xs">
              {formatNumber(qrTarget.scanCount)} scan
              {qrTarget.scanCount === 1 ? "" : "s"} recorded. Scans are counted
              separately from link clicks; re-targeting the link updates where
              the code leads.
            </p>
            <div className="flex gap-2">
              <a
                href={linkQrUrl(qrTarget.id, { format: "png", size: 1024 })}
                download={`${qrTarget.slug ?? qrTarget.id}-qr.png`}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-hairline-faint bg-white/[0.04] px-3 font-medium text-sm text-white/90 hover:bg-white/[0.08]"
              >
                <Download className="h-4 w-4" />
                PNG
              </a>
              <a
                href={linkQrUrl(qrTarget.id, { format: "svg", size: 512 })}
                download={`${qrTarget.slug ?? qrTarget.id}-qr.svg`}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-hairline-faint bg-white/[0.04] px-3 font-medium text-sm text-white/90 hover:bg-white/[0.08]"
              >
                <Download className="h-4 w-4" />
                SVG
              </a>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => archiveTarget && archive.mutate(archiveTarget.id)}
        title="Archive this link?"
        description={
          archiveTarget
            ? `"${archiveTarget.label ?? archiveTarget.originalUrl}" will be hidden from the list. The short URL keeps redirecting and existing clicks are kept.`
            : undefined
        }
        confirmLabel="Archive"
        loading={archive.isPending}
      />
    </div>
  );
}
