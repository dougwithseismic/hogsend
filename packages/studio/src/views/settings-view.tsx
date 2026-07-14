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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
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
import { useToast } from "@/components/ui/toast";
import {
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  deleteFxSetting,
  type FxSettingState,
  getFxSetting,
  listApiKeys,
  putFxSetting,
  qk,
  revokeApiKey,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Scope = "read" | "journey-admin" | "full-admin";
const SCOPES: Scope[] = ["read", "journey-admin", "full-admin"];

// ~20 majors — the reporting currencies the dropdown offers. Anything more
// exotic stays configurable via env/API; the card is the common path.
const MAJOR_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CNY",
  "AUD",
  "CAD",
  "CHF",
  "INR",
  "SEK",
  "NOK",
  "DKK",
  "NZD",
  "SGD",
  "HKD",
  "KRW",
  "BRL",
  "MXN",
  "ZAR",
  "PLN",
];

// Browser-locale region → that region's major currency, for the dropdown's
// initial SUGGESTION only — a suggestion is never saved until the operator
// clicks Save.
const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  JP: "JPY",
  CN: "CNY",
  AU: "AUD",
  CA: "CAD",
  CH: "CHF",
  IN: "INR",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  NZ: "NZD",
  SG: "SGD",
  HK: "HKD",
  KR: "KRW",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  PL: "PLN",
  // Eurozone regions that resolve to the same major.
  AT: "EUR",
  BE: "EUR",
  DE: "EUR",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GR: "EUR",
  IE: "EUR",
  IT: "EUR",
  NL: "EUR",
  PT: "EUR",
};

function suggestedCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).region;
    return (region && REGION_CURRENCY[region]) || "USD";
  } catch {
    return "USD";
  }
}

/** Where the effective base comes from, in the operator's terms. */
function fxSourceLabel(state: FxSettingState): string {
  if (state.setting) {
    return state.setting.baseCurrency === null
      ? "turned off here — overrides the env default"
      : "set here";
  }
  return state.env.baseCurrency !== null
    ? "from the BASE_CURRENCY environment variable"
    : "not configured";
}

function CurrencyCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: qk.fxSetting, queryFn: getFxSetting });

  // null = untouched: the dropdown shows the effective base when one is set,
  // else the locale-derived suggestion. Nothing persists until Save.
  const [selected, setSelected] = useState<string | null>(null);

  function applyResult(res: FxSettingState, title: string) {
    queryClient.setQueryData(qk.fxSetting, res);
    setSelected(null);
    // Group revenue views render through the lens — refresh them.
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    void queryClient.invalidateQueries({ queryKey: ["group"] });
    toast({ title });
  }

  function onError(error: unknown) {
    toast({
      variant: "error",
      title: "Could not update currency",
      description:
        error instanceof ApiError ? error.message : "Unexpected error.",
    });
  }

  const save = useMutation({
    mutationFn: (code: string) => putFxSetting(code),
    onSuccess: (res) => applyResult(res, "Base currency saved"),
    onError,
  });
  const turnOff = useMutation({
    mutationFn: () => putFxSetting(null),
    onSuccess: (res) => applyResult(res, "Currency conversion turned off"),
    onError,
  });
  const clear = useMutation({
    mutationFn: () => deleteFxSetting(),
    onSuccess: (res) =>
      applyResult(res, "Override cleared — using the env default"),
    onError,
  });

  const state = query.data;
  const effective = state?.effective.baseCurrency ?? null;
  const dropdownValue = selected ?? effective ?? suggestedCurrency();
  const busy = save.isPending || turnOff.isPending || clear.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Currency</CardTitle>
        <CardDescription>
          The reporting currency group revenue is converted into. Off = revenue
          shows per-currency only, never converted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : state ? (
          <>
            <div className="flex items-center gap-2 text-sm">
              {effective ? (
                <>
                  <Badge
                    variant="outline"
                    className="border-white/15 bg-white/[0.06] text-white/80"
                  >
                    {effective}
                  </Badge>
                  <span className="text-white/60">{fxSourceLabel(state)}</span>
                </>
              ) : (
                <>
                  <Badge variant="secondary">Off</Badge>
                  <span className="text-white/60">{fxSourceLabel(state)}</span>
                </>
              )}
            </div>

            {/* Rate-source status. `servesEffectiveBase: false` with a base
                set = the honesty rule refusing to mis-convert. */}
            {effective && state.provider === null ? (
              <p className="text-sm text-amber-400/90">
                No exchange-rate source is configured, so converted figures
                won't appear. Set FX_RATES (a rate sheet quoted in {effective})
                or FX_PROVIDER=frankfurter on the API.
              </p>
            ) : null}
            {effective &&
            state.provider &&
            !state.provider.servesEffectiveBase ? (
              <p className="text-sm text-amber-400/90">
                {state.provider.id === "static" ? (
                  <>
                    Your FX_RATES sheet is quoted in{" "}
                    {state.env.baseCurrency ?? "no base currency"} and can't
                    honestly convert into {effective}, so converted figures
                    won't appear. Re-quote the sheet in {effective} (and set
                    BASE_CURRENCY to match), or switch to
                    FX_PROVIDER=frankfurter, which re-bases automatically.
                  </>
                ) : (
                  <>
                    The {state.provider.id} rate source has no rates for{" "}
                    {effective}, so converted figures won't appear.
                  </>
                )}
              </p>
            ) : null}
            {effective && state.provider?.servesEffectiveBase ? (
              <p className="text-sm text-white/60">
                Rates from {state.provider.id}
                {state.provider.asOf ? `, as of ${state.provider.asOf}` : ""}.
              </p>
            ) : null}

            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44 space-y-1.5">
                <Label htmlFor="fx-base-currency">Base currency</Label>
                <Select
                  id="fx-base-currency"
                  value={dropdownValue}
                  onChange={(e) => setSelected(e.target.value)}
                  disabled={busy}
                >
                  {MAJOR_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                onClick={() => save.mutate(dropdownValue)}
                disabled={busy || dropdownValue === effective}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={() => turnOff.mutate()}
                disabled={
                  busy || (effective === null && state.setting !== null)
                }
              >
                {turnOff.isPending ? "Turning off…" : "Turn off"}
              </Button>
              {state.setting !== null ? (
                <Button
                  variant="outline"
                  onClick={() => clear.mutate()}
                  disabled={busy}
                >
                  {clear.isPending ? "Clearing…" : "Clear override"}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

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
        description="API keys for programmatic access, and operator settings."
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

      <CurrencyCard />

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
