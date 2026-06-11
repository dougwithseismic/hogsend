import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
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
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  listApiKeys,
  qk,
  revokeApiKey,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Scope = "read" | "journey-admin" | "full-admin";
const SCOPES: Scope[] = ["read", "journey-admin", "full-admin"];

export function SettingsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const query = useQuery({ queryKey: qk.apiKeys, queryFn: listApiKeys });

  const create = useMutation({
    mutationFn: () => createApiKey({ name: name.trim(), scopes }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setName("");
      setScopes(["read"]);
      setCreatedKey(res);
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Could not create key",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      toast({ title: "API key revoked" });
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: qk.apiKeys });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Revoke failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setRevokeTarget(null);
    },
  });

  function toggleScope(scope: Scope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function copyKey(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ variant: "error", title: "Copy failed" });
    }
  }

  const keys = query.data?.keys ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="API keys for programmatic access to the Hogsend admin API."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New API key
          </Button>
        }
      />

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create a key to authenticate API and webhook requests."
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const revoked = key.revokedAt !== null;
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium text-white">
                      {key.name}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-white/70">
                      {key.keyPrefix}…
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-white/60">
                      {formatDateTime(key.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      {revoked ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-white/15 bg-white/[0.06] text-white/80"
                        >
                          Active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!revoked ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRevokeTarget(key)}
                        >
                          Revoke
                        </Button>
                      ) : null}
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
        title="Create API key"
        description="Choose a descriptive name and the scopes this key needs."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => create.mutate()}
              disabled={!name.trim() || scopes.length === 0 || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            placeholder="CI ingest key"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Scopes</Label>
          <div className="flex flex-col gap-2">
            {SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-center gap-2 text-sm text-white/80"
                htmlFor={`scope-${scope}`}
              >
                <input
                  id={`scope-${scope}`}
                  type="checkbox"
                  className="h-4 w-4 rounded border-hairline-faint accent-accent"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                {scope}
              </label>
            ))}
          </div>
        </div>
      </Dialog>

      {/* One-time secret reveal */}
      <Dialog
        open={createdKey !== null}
        onClose={() => setCreatedKey(null)}
        title="API key created"
        description="Copy this key now — it will not be shown again."
        footer={<Button onClick={() => setCreatedKey(null)}>Done</Button>}
      >
        {createdKey ? (
          <div className="space-y-2">
            <Label>Secret key</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-xs text-white/90">
                {createdKey.key}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyKey(createdKey.key)}
                aria-label="Copy key"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
        title="Revoke this API key?"
        description={
          revokeTarget
            ? `"${revokeTarget.name}" will stop working immediately. This cannot be undone.`
            : undefined
        }
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
      />
    </div>
  );
}
