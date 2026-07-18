import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConditionBuilder } from "@/components/condition-builder";
import { ErrorState, TableSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/components/ui/toast";
import {
  createFlag,
  type Flag,
  type FlagCreateBody,
  type FlagTargeting,
  type FlagType,
  type FlagUpdateBody,
  getTargetingCatalog,
  getTargetingCount,
  listFlags,
  qk,
  type TargetingCatalog,
  updateFlag,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  buildBody,
  type ConditionSetDraft,
  emptyConditionSet,
  type FormState,
  initialForm,
  JsonField,
  slugify,
} from "./flag-form";

/**
 * Full-page flag editor (create + edit) — the replacement for the old modal.
 * Mirrors the campaign detail page's shape: a back link, a sticky Cancel/Save
 * header, and a grid of Card sections. Targeting is edited as one or more ORDERED
 * condition sets (each a <ConditionBuilder> tree + its own rollout slider + a
 * live match estimate); the engine evaluates them in order and the first match
 * wins. All shapes are validated server-side — the form only catches the obvious
 * mistakes before the round-trip.
 */
export function FlagEditorView({
  mode,
  flagId,
}: {
  mode: "create" | "edit";
  flagId?: string;
}) {
  // Only the edit route needs the flag; disable the fetch for create. Loading
  // the full (incl. archived) list keeps a direct URL to any flag resolvable.
  const query = useQuery({
    queryKey: qk.flags(true),
    queryFn: () => listFlags(true),
    enabled: mode === "edit",
  });

  if (mode === "edit") {
    if (query.isPending) {
      return (
        <div className="space-y-6">
          <BackLink />
          <TableSkeleton />
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className="space-y-6">
          <BackLink />
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </div>
      );
    }
    const flag = query.data.flags.find((f) => f.id === flagId);
    if (!flag) {
      return (
        <div className="space-y-6">
          <BackLink />
          <ErrorState
            error={new Error("Flag not found.")}
            onRetry={() => query.refetch()}
          />
        </div>
      );
    }
    return <FlagEditorForm key={flag.id} mode="edit" flag={flag} />;
  }

  return <FlagEditorForm key="create" mode="create" />;
}

function BackLink() {
  return (
    <Link
      to="/flags"
      className="inline-flex items-center gap-1 text-sm text-white/50 hover:text-white/80"
    >
      <ArrowLeft className="h-4 w-4" />
      Flags
    </Link>
  );
}

function FlagEditorForm({
  mode,
  flag,
}: {
  mode: "create" | "edit";
  flag?: Flag;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [state, setState] = useState<FormState>(() => initialForm(flag));
  const [error, setError] = useState<string | null>(null);
  // While creating, the key auto-follows the name until the user edits it by
  // hand; editing an existing flag starts "dirty" so we never rewrite its key.
  const [keyDirty, setKeyDirty] = useState(mode === "edit");

  // Seeds the ConditionBuilder property combobox + operator vocabulary. The
  // builder degrades to free-text + a built-in operator set while this loads.
  const catalogQuery = useQuery({
    queryKey: qk.targetingCatalog,
    queryFn: getTargetingCatalog,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (body: FlagCreateBody | FlagUpdateBody) =>
      mode === "create"
        ? createFlag(body as FlagCreateBody)
        : updateFlag(flag?.id ?? "", body as FlagUpdateBody),
    onSuccess: () => {
      toast({ title: mode === "create" ? "Flag created" : "Flag saved" });
      void queryClient.invalidateQueries({ queryKey: ["flags"] });
      void navigate({ to: "/flags" });
    },
    onError: (e: unknown) =>
      toast({
        variant: "error",
        title:
          mode === "create" ? "Could not create flag" : "Could not save flag",
        description: e instanceof ApiError ? e.message : "Unexpected error.",
      }),
  });

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function setName(value: string) {
    setState((prev) => ({
      ...prev,
      name: value,
      key: keyDirty ? prev.key : slugify(value),
    }));
  }

  function setKey(value: string) {
    setKeyDirty(true);
    set("key", value);
  }

  function updateSet(index: number, patch: Partial<ConditionSetDraft>) {
    setState((prev) => ({
      ...prev,
      conditionSets: prev.conditionSets.map((s, i) =>
        i === index ? { ...s, ...patch } : s,
      ),
    }));
  }

  function removeSet(index: number) {
    setState((prev) => ({
      ...prev,
      conditionSets: prev.conditionSets.filter((_, i) => i !== index),
    }));
  }

  function addSet() {
    setState((prev) => ({
      ...prev,
      conditionSets: [...prev.conditionSets, emptyConditionSet()],
    }));
  }

  function submit() {
    const result = buildBody(state, mode);
    if (result.error || !result.body) {
      setError(result.error ?? "Invalid form.");
      return;
    }
    setError(null);
    save.mutate(result.body);
  }

  return (
    <div className="space-y-6">
      <BackLink />

      {/* Sticky action bar — Cancel + Save follow the scroll like a page toolbar. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-hairline-faint border-b bg-ink/80 py-3 backdrop-blur">
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl text-white tracking-[-0.02em]">
            {mode === "create" ? "New flag" : (flag?.name ?? "Edit flag")}
          </h1>
          <p className="mt-1 text-sm text-white/60">
            {mode === "create"
              ? "A native, DB-backed feature flag — evaluated live by your SDKs and journeys."
              : "Changes take effect live — no redeploy."}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/flags" })}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending
              ? "Saving…"
              : mode === "create"
                ? "Create flag"
                : "Save changes"}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-red-300 text-sm">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* General */}
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Name, key, and the live switch.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="flag-name">Name</Label>
              <Input
                id="flag-name"
                placeholder="New checkout flow"
                value={state.name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="flag-key">Key</Label>
              <Input
                id="flag-key"
                className="font-mono text-xs"
                placeholder="new-checkout-flow"
                value={state.key}
                onChange={(e) => setKey(e.target.value)}
              />
              <p className="text-white/40 text-xs">
                The identifier your SDK reads. Auto-filled from the name — edit
                it any time; it must stay unique.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="flag-description">Description</Label>
              <Input
                id="flag-description"
                placeholder="Optional"
                value={state.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Flag type */}
        <Card>
          <CardHeader>
            <CardTitle>Flag type</CardTitle>
            <CardDescription>
              What the flag serves when a contact matches.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FlagTypeCards
              value={state.type}
              onChange={(next) => set("type", next)}
            />
            {state.type === "multivariate" ? (
              <JsonField
                id="flag-variants"
                label="Variants"
                hint="A JSON array of arms: { key, value, weight }."
                value={state.variantsJson}
                onChange={(v) => set("variantsJson", v)}
                rows={5}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Release conditions — the ordered condition-set repeater. */}
      <div className="space-y-3">
        <div>
          <h2 className="font-display text-lg text-white tracking-[-0.02em]">
            Release conditions
          </h2>
          <p className="mt-1 text-sm text-white/60">
            Ordered rules — the first set whose targeting matches AND whose
            rollout admits the contact turns the flag on. Empty targeting
            matches everyone.
          </p>
        </div>

        <div className="space-y-4">
          {state.conditionSets.map((cset, index) => (
            <ConditionSetCard
              // biome-ignore lint/suspicious/noArrayIndexKey: sets are positional (order is the rule)
              key={index}
              index={index}
              total={state.conditionSets.length}
              set={cset}
              catalog={catalogQuery.data}
              onTargetingChange={(targeting) => updateSet(index, { targeting })}
              onRolloutChange={(rollout) => updateSet(index, { rollout })}
              onRemove={() => removeSet(index)}
            />
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={addSet}>
          <Plus className="h-3.5 w-3.5" />
          Add condition set
        </Button>
      </div>

      {/* Advanced — the default value, tucked away. */}
      <AdvancedSection
        type={state.type}
        defaultBool={state.defaultBool}
        defaultJson={state.defaultJson}
        onDefaultBoolChange={(v) => set("defaultBool", v)}
        onDefaultJsonChange={(v) => set("defaultJson", v)}
      />
    </div>
  );
}

// --- Flag type radio cards -------------------------------------------------

const FLAG_TYPES: Array<{ value: FlagType; title: string; desc: string }> = [
  {
    value: "boolean",
    title: "Boolean",
    desc: "A simple on/off switch — serves true or false.",
  },
  {
    value: "multivariate",
    title: "Multivariate",
    desc: "Weighted arms — serves one variant value per contact.",
  },
];

function FlagTypeCards({
  value,
  onChange,
}: {
  value: FlagType;
  onChange: (next: FlagType) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {FLAG_TYPES.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative rounded-md border p-3 text-left transition-colors duration-200",
              selected
                ? "border-accent bg-accent/[0.06] ring-1 ring-accent"
                : "border-hairline-faint bg-white/[0.015] hover:border-white/15",
            )}
          >
            {selected ? (
              <span className="absolute right-2 top-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white">
                <Check className="h-3 w-3" />
              </span>
            ) : null}
            <span className="block font-medium text-sm text-white">
              {opt.title}
            </span>
            <span className="mt-1 block text-white/50 text-xs">{opt.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

// --- One condition set card ------------------------------------------------

function ConditionSetCard({
  index,
  total,
  set,
  catalog,
  onTargetingChange,
  onRolloutChange,
  onRemove,
}: {
  index: number;
  total: number;
  set: ConditionSetDraft;
  catalog: TargetingCatalog | undefined;
  onTargetingChange: (next: FlagTargeting) => void;
  onRolloutChange: (next: number) => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Condition set {index + 1}
          {total > 1 ? (
            <span className="ml-2 font-normal text-white/40 text-xs">
              rule {index + 1} of {total}
            </span>
          ) : null}
        </CardTitle>
        {total > 1 ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove condition set"
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ConditionBuilder
          value={set.targeting}
          onChange={onTargetingChange}
          catalog={catalog}
        />

        <div className="space-y-2 border-hairline-faint border-t pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`rollout-${index}`}>Rollout</Label>
            <MatchEstimate targeting={set.targeting} />
          </div>
          <div className="flex items-center gap-3">
            <Slider
              aria-label={`Rollout for condition set ${index + 1}`}
              value={set.rollout}
              onChange={onRolloutChange}
            />
            <div className="flex w-24 shrink-0 items-center gap-1">
              <Input
                id={`rollout-${index}`}
                type="number"
                min={0}
                max={100}
                value={set.rollout}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onRolloutChange(
                    Number.isFinite(n)
                      ? Math.max(0, Math.min(100, Math.round(n)))
                      : 0,
                  );
                }}
                className="h-8 text-xs"
              />
              <span className="text-white/40 text-xs">%</span>
            </div>
          </div>
          <p className="text-white/40 text-xs">
            Percent of matching contacts served a non-default value. Sticky per
            contact.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Live match estimate ---------------------------------------------------

/** Debounce a value so a fast-typing builder edit doesn't fire a POST per keystroke. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function MatchEstimate({ targeting }: { targeting: FlagTargeting }) {
  const debounced = useDebouncedValue(targeting, 400);
  const query = useQuery({
    queryKey: qk.targetingCount(debounced),
    queryFn: () => getTargetingCount(debounced),
    staleTime: 30_000,
  });

  if (query.isError) {
    return <span className="text-white/30 text-xs">estimate unavailable</span>;
  }
  if (query.isPending || query.isFetching) {
    return <span className="text-white/30 text-xs">estimating…</span>;
  }
  const { estimatedTotal, matched, sampled } = query.data;
  return (
    <span className="text-white/50 text-xs">
      ~{formatNumber(estimatedTotal)} contacts match
      <span className="text-white/30">
        {" "}
        ({matched}/{sampled} sampled)
      </span>
    </span>
  );
}

// --- Advanced (collapsible) ------------------------------------------------

function AdvancedSection({
  type,
  defaultBool,
  defaultJson,
  onDefaultBoolChange,
  onDefaultJsonChange,
}: {
  type: FlagType;
  defaultBool: boolean;
  defaultJson: string;
  onDefaultBoolChange: (next: boolean) => void;
  onDefaultJsonChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-6 text-left"
      >
        <div>
          <CardTitle>Advanced</CardTitle>
          <CardDescription className="mt-1.5">
            The value served when the flag is off, targeting fails, or a contact
            is outside every rollout.
          </CardDescription>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-white/40" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-white/40" />
        )}
      </button>
      {open ? (
        <CardContent>
          {type === "boolean" ? (
            <div className="w-40 space-y-1.5">
              <Label htmlFor="flag-default-bool">Default value</Label>
              <Select
                id="flag-default-bool"
                value={defaultBool ? "true" : "false"}
                onChange={(e) => onDefaultBoolChange(e.target.value === "true")}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </Select>
            </div>
          ) : (
            <JsonField
              id="flag-default-json"
              label="Default value"
              hint="Any JSON — served when the flag doesn't match."
              value={defaultJson}
              onChange={onDefaultJsonChange}
              rows={2}
            />
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
