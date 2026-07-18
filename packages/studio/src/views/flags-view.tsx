import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag as FlagIcon, Plus } from "lucide-react";
import { useState } from "react";
import {
  ConditionBuilder,
  emptyTargetingGroup,
  toTargetingGroup,
} from "@/components/condition-builder";
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
import { Switch } from "@/components/ui/switch";
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
  archiveFlag,
  createFlag,
  type Flag,
  type FlagCreateBody,
  type FlagTargeting,
  type FlagTargetingCondition,
  type FlagType,
  type FlagUpdateBody,
  type FlagVariant,
  getTargetingCatalog,
  listFlags,
  qk,
  updateFlag,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Native feature-flags view. Unlike observe-only Groups/Buckets, flags are
 * OPERATOR-editable here: the row's `enabled` Switch and the rollout/targeting
 * editors PATCH the flag and take effect live (no redeploy) — that instant
 * switch is the whole reason flags exist. Create mints a DB-backed flag; archive
 * is a soft-delete that frees the key.
 *
 * Targeting is edited with the reusable <ConditionBuilder> (an AND/OR tree of
 * PROPERTY leaves); multivariate variants + a non-scalar default value are still
 * edited as JSON textareas. All shapes are validated server-side.
 */
export function FlagsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Flag | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Flag | null>(null);

  const query = useQuery({
    queryKey: qk.flags(includeArchived),
    queryFn: () => listFlags(includeArchived),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["flags"] });
  }

  function onMutationError(title: string) {
    return (error: unknown) =>
      toast({
        variant: "error",
        title,
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
  }

  const create = useMutation({
    mutationFn: (body: FlagCreateBody) => createFlag(body),
    onSuccess: () => {
      toast({ title: "Flag created" });
      setCreateOpen(false);
      invalidate();
    },
    onError: onMutationError("Could not create flag"),
  });

  // Shared by the inline enabled Switch AND the edit dialog — the id in the
  // mutation variables lets a single per-row Switch show its own pending state.
  const update = useMutation({
    mutationFn: (vars: { id: string; body: FlagUpdateBody }) =>
      updateFlag(vars.id, vars.body),
    onSuccess: () => {
      setEditTarget(null);
      invalidate();
    },
    onError: onMutationError("Could not update flag"),
  });

  const archive = useMutation({
    mutationFn: (id: string) => archiveFlag(id),
    onSuccess: () => {
      toast({ title: "Flag archived" });
      setArchiveTarget(null);
      invalidate();
    },
    onError: onMutationError("Could not archive flag"),
  });

  const flags = query.data?.flags ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flags"
        description="Native, DB-backed feature flags — toggle, roll out, and target live without a redeploy."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New flag
          </Button>
        }
      />

      <div className="flex items-center justify-end">
        <label
          className="flex cursor-pointer items-center gap-2 text-sm text-white/60"
          htmlFor="flags-show-archived"
        >
          Show archived
          <Switch
            aria-label="Show archived flags"
            checked={includeArchived}
            onCheckedChange={setIncludeArchived}
          />
        </label>
      </div>

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : flags.length === 0 ? (
        <EmptyState
          icon={FlagIcon}
          title="No flags yet"
          description="Create a feature flag to gate rollouts, run experiments, or ship dark launches — evaluated live by the SDKs and journeys."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New flag
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-white/[0.015]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flag</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-right">Rollout</TableHead>
                <TableHead>Targeting</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => {
                const archived = flag.archivedAt !== null;
                const toggling =
                  update.isPending && update.variables?.id === flag.id;
                return (
                  <TableRow
                    key={flag.id}
                    className={cn(archived && "opacity-50")}
                  >
                    <TableCell>
                      <span className="font-medium text-white">
                        {flag.name}
                      </span>
                      <span className="block font-mono text-white/70 text-xs">
                        {flag.key}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{flag.type}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate font-mono text-white/70 text-xs">
                      {renderValue(flag.defaultValue)}
                    </TableCell>
                    <TableCell className="text-right text-white/80">
                      {flag.rollout}%
                    </TableCell>
                    <TableCell className="max-w-[18rem] text-white/60 text-xs">
                      {targetingSummary(flag.targeting)}
                    </TableCell>
                    <TableCell>
                      {archived ? (
                        <Badge variant="destructive">Archived</Badge>
                      ) : (
                        <Switch
                          aria-label={`Toggle ${flag.name}`}
                          checked={flag.enabled}
                          disabled={toggling}
                          onCheckedChange={(next) =>
                            update.mutate({
                              id: flag.id,
                              body: { enabled: next },
                            })
                          }
                        />
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!archived ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditTarget(flag)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setArchiveTarget(flag)}
                          >
                            Archive
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {createOpen ? (
        <FlagFormDialog
          mode="create"
          submitting={create.isPending}
          onClose={() => setCreateOpen(false)}
          onSubmit={(body) => create.mutate(body as FlagCreateBody)}
        />
      ) : null}

      {editTarget ? (
        <FlagFormDialog
          mode="edit"
          flag={editTarget}
          submitting={update.isPending}
          onClose={() => setEditTarget(null)}
          onSubmit={(body) =>
            update.mutate({ id: editTarget.id, body: body as FlagUpdateBody })
          }
        />
      ) : null}

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => archiveTarget && archive.mutate(archiveTarget.id)}
        title="Archive this flag?"
        description={
          archiveTarget
            ? `"${archiveTarget.name}" will stop being served and its key (${archiveTarget.key}) frees for reuse. This is a soft-delete.`
            : undefined
        }
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
      />
    </div>
  );
}

// --- Rendering helpers -----------------------------------------------------

/** A default/variant value in a table cell — scalars render, containers JSON. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}

/** Render one PROPERTY leaf as "prop operator value". */
function leafSummary(c: FlagTargetingCondition): string {
  return [c.property, c.operator, c.value === undefined ? "" : String(c.value)]
    .filter(Boolean)
    .join(" ");
}

/**
 * One-line targeting summary over the condition tree (or a legacy bare array);
 * empty targeting matches everyone. Nested groups render parenthesized and
 * joined by their own AND/OR conjunction.
 */
function targetingSummary(
  targeting: FlagTargeting | FlagTargetingCondition[],
): string {
  const group = toTargetingGroup(targeting);
  return summarizeGroup(group, true) || "Everyone";
}

function summarizeGroup(node: FlagTargeting, top: boolean): string {
  if (node.type === "property") return leafSummary(node);
  const joiner = node.operator === "or" ? " OR " : " AND ";
  const parts = node.conditions
    .map((child) => summarizeGroup(child, false))
    .filter(Boolean);
  if (parts.length === 0) return "";
  const joined = parts.join(joiner);
  return top || parts.length === 1 ? joined : `(${joined})`;
}

// --- Create / edit form ----------------------------------------------------

type FormState = {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  rollout: string;
  /** Boolean flags: the served-off value. */
  defaultBool: boolean;
  /** Multivariate flags: the served-off value, as JSON. */
  defaultJson: string;
  /** Multivariate flags: the arms, as JSON (FlagVariant[]). */
  variantsJson: string;
  /** Targeting predicate, as a condition tree (composite root). */
  targeting: FlagTargeting;
};

function initialForm(flag?: Flag): FormState {
  if (!flag) {
    return {
      key: "",
      name: "",
      description: "",
      type: "boolean",
      rollout: "100",
      defaultBool: false,
      defaultJson: "null",
      variantsJson: "[]",
      targeting: emptyTargetingGroup(),
    };
  }
  return {
    key: flag.key,
    name: flag.name,
    description: flag.description ?? "",
    type: flag.type,
    rollout: String(flag.rollout),
    defaultBool: flag.defaultValue === true,
    defaultJson: JSON.stringify(flag.defaultValue ?? null, null, 2),
    variantsJson: JSON.stringify(flag.variants ?? [], null, 2),
    // Normalize a legacy bare array / lone leaf into an editable group.
    targeting: toTargetingGroup(flag.targeting),
  };
}

/**
 * Build the request body from the form, or an error string when a JSON field
 * is malformed / the rollout is out of range. Create needs key+name; edit omits
 * the immutable key. The engine does the authoritative validation — this just
 * catches the obvious mistakes before the round-trip.
 */
function buildBody(
  state: FormState,
  mode: "create" | "edit",
): { body?: FlagCreateBody | FlagUpdateBody; error?: string } {
  const name = state.name.trim();
  if (!name) return { error: "Name is required." };

  const rollout = Number(state.rollout);
  if (
    !Number.isInteger(rollout) ||
    rollout < 0 ||
    rollout > 100 ||
    state.rollout.trim() === ""
  ) {
    return { error: "Rollout must be a whole number between 0 and 100." };
  }

  let defaultValue: unknown;
  let variants: FlagVariant[] = [];
  if (state.type === "boolean") {
    defaultValue = state.defaultBool;
  } else {
    const dv = parseJson<unknown>(state.defaultJson, null);
    if (dv.error) return { error: `Default value: ${dv.error}` };
    defaultValue = dv.value;
    const vs = parseJson<FlagVariant[]>(state.variantsJson, []);
    if (vs.error) return { error: `Variants: ${vs.error}` };
    if (!Array.isArray(vs.value)) {
      return { error: "Variants must be a JSON array." };
    }
    variants = vs.value;
  }

  const key = state.key.trim();
  if (!key) return { error: "Key is required." };

  const common: FlagUpdateBody = {
    key,
    name,
    description: state.description.trim() || undefined,
    type: state.type,
    rollout,
    targeting: state.targeting,
    defaultValue,
    variants,
  };

  if (mode === "edit") return { body: common };
  return { body: { ...common, type: state.type } as FlagCreateBody };
}

/** Slugify a name into a stable key: lowercase, non-alphanumerics → hyphens. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseJson<T>(raw: string, empty: T): { value?: T; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: empty };
  try {
    return { value: JSON.parse(trimmed) as T };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

function FlagFormDialog({
  mode,
  flag,
  submitting,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  flag?: Flag;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: FlagCreateBody | FlagUpdateBody) => void;
}) {
  const [state, setState] = useState<FormState>(() => initialForm(flag));
  const [error, setError] = useState<string | null>(null);
  // While creating, the key auto-follows the name until the user edits it by
  // hand; editing an existing flag starts "dirty" so we never rewrite its key.
  const [keyDirty, setKeyDirty] = useState(mode === "edit");

  // Seeds the ConditionBuilder's property combobox + operator vocabulary. The
  // builder degrades to free-text + a built-in operator set while this loads.
  const catalogQuery = useQuery({
    queryKey: qk.targetingCatalog,
    queryFn: getTargetingCatalog,
    staleTime: 60_000,
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

  function submit() {
    const result = buildBody(state, mode);
    if (result.error || !result.body) {
      setError(result.error ?? "Invalid form.");
      return;
    }
    setError(null);
    onSubmit(result.body);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "create" ? "Create flag" : `Edit ${flag?.name ?? "flag"}`}
      description={
        mode === "create"
          ? "A native, DB-backed feature flag — evaluated live by your SDKs and journeys."
          : "Changes take effect live — no redeploy."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting
              ? "Saving…"
              : mode === "create"
                ? "Create flag"
                : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
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
            placeholder="new-checkout-flow"
            value={state.key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-white/40 text-xs">
            The identifier your SDK reads. Auto-filled from the name — edit it
            any time; it must stay unique.
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

        <div className="flex gap-4">
          <div className="w-40 space-y-1.5">
            <Label htmlFor="flag-type">Type</Label>
            <Select
              id="flag-type"
              value={state.type}
              onChange={(e) => set("type", e.target.value as FlagType)}
            >
              <option value="boolean">boolean</option>
              <option value="multivariate">multivariate</option>
            </Select>
          </div>
          <div className="w-40 space-y-1.5">
            <Label htmlFor="flag-rollout">Rollout %</Label>
            <Input
              id="flag-rollout"
              type="number"
              min={0}
              max={100}
              value={state.rollout}
              onChange={(e) => set("rollout", e.target.value)}
            />
          </div>
        </div>

        {state.type === "boolean" ? (
          <div className="w-40 space-y-1.5">
            <Label htmlFor="flag-default-bool">Default value</Label>
            <Select
              id="flag-default-bool"
              value={state.defaultBool ? "true" : "false"}
              onChange={(e) => set("defaultBool", e.target.value === "true")}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </Select>
            <p className="text-white/40 text-xs">
              Served when disabled, targeting fails, or outside the rollout.
            </p>
          </div>
        ) : (
          <>
            <JsonField
              id="flag-variants"
              label="Variants"
              hint="A JSON array of arms: { key, value, weight }."
              value={state.variantsJson}
              onChange={(v) => set("variantsJson", v)}
              rows={5}
            />
            <JsonField
              id="flag-default-json"
              label="Default value"
              hint="Any JSON — served when the flag doesn't match."
              value={state.defaultJson}
              onChange={(v) => set("defaultJson", v)}
              rows={2}
            />
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="flag-targeting">Targeting</Label>
          <div id="flag-targeting">
            <ConditionBuilder
              value={state.targeting}
              onChange={(next) => set("targeting", next)}
              catalog={catalogQuery.data}
            />
          </div>
          <p className="text-white/40 text-xs">
            Only contacts matching these conditions are eligible. Empty =
            everyone matches.
          </p>
        </div>

        {error ? <p className="text-red-400 text-sm">{error}</p> : null}
      </div>
    </Dialog>
  );
}

function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
  rows,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  rows: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex w-full rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-white text-xs transition-colors duration-200 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <p className="text-white/40 text-xs">{hint}</p>
    </div>
  );
}
