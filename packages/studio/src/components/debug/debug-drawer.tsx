import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Plus, Shuffle, Trash2, Zap } from "lucide-react";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { EventPicker } from "@/components/event-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  type IngestResult,
  ingestEvent,
  listEventNames,
  listJourneys,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";

/**
 * Lets any view under <AppShell> open the global debug drawer (e.g. the Overview
 * getting-started CTA). AppShell owns the open state and provides the opener.
 */
const FireEventContext = createContext<(() => void) | null>(null);

export { FireEventContext };

export function useFireEvent(): () => void {
  const fire = useContext(FireEventContext);
  if (!fire) {
    throw new Error("useFireEvent must be used within <AppShell>");
  }
  return fire;
}

function randomUserId(): string {
  return `test_${Math.random().toString(36).slice(2, 10)}`;
}

/** Event properties are scalars on the wire; the editor builds them by type. */
type PropType = "string" | "number" | "boolean";
type PropRow = { id: number; key: string; type: PropType; value: string };

/**
 * Coerce the typed key/value rows into the scalar property object the ingest
 * API expects. Rows with a blank key are skipped; a number row that doesn't
 * parse fails loudly (rather than silently sending NaN).
 */
function buildProperties(rows: PropRow[]): {
  properties: Record<string, unknown>;
  error: string | null;
} {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (Object.hasOwn(out, key)) {
      return { properties: {}, error: `"${key}" is set more than once.` };
    }
    if (row.type === "number") {
      const n = Number(row.value);
      // Number.isFinite rejects NaN AND Infinity/-Infinity — the latter would
      // otherwise serialize to null in the JSON body (a silent type leak).
      if (row.value.trim() === "" || !Number.isFinite(n)) {
        return { properties: {}, error: `"${key}" is not a valid number.` };
      }
      out[key] = n;
    } else if (row.type === "boolean") {
      out[key] = row.value === "true";
    } else {
      out[key] = row.value;
    }
  }
  return { properties: out, error: null };
}

function PropertyEditor({
  rows,
  onChange,
}: {
  rows: PropRow[];
  onChange: (rows: PropRow[]) => void;
}) {
  const update = (id: number, patch: Partial<PropRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: number) => onChange(rows.filter((r) => r.id !== id));

  if (rows.length === 0) {
    return (
      <p className="text-sm text-white/40">
        No properties — add scalar key/value pairs below.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label="Property key"
            placeholder="key"
            className="flex-1"
            value={row.key}
            onChange={(e) => update(row.id, { key: e.target.value })}
          />
          <Select
            aria-label="Property type"
            className="w-28 shrink-0"
            value={row.type}
            onChange={(e) => {
              const type = e.target.value as PropType;
              update(row.id, {
                type,
                // To boolean → seed "true"; from boolean → clear the literal.
                value:
                  type === "boolean"
                    ? "true"
                    : row.type === "boolean"
                      ? ""
                      : row.value,
              });
            }}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </Select>
          {row.type === "boolean" ? (
            <Select
              aria-label="Property value"
              className="w-28 shrink-0"
              value={row.value === "false" ? "false" : "true"}
              onChange={(e) => update(row.id, { value: e.target.value })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          ) : (
            <Input
              aria-label="Property value"
              className="flex-1"
              inputMode={row.type === "number" ? "decimal" : undefined}
              placeholder={row.type === "number" ? "0" : "value"}
              value={row.value}
              onChange={(e) => update(row.id, { value: e.target.value })}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove property"
            className="shrink-0"
            onClick={() => remove(row.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Global debug drawer — fires events straight into POST /v1/admin/events (the
 * same path real events take), so journeys can be exercised from anywhere in
 * Studio without leaving the current page. Properties are entered as typed
 * scalars (string/number/boolean) so the payload matches what real code sends.
 */
export function DebugDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [event, setEvent] = useState("");
  const [userId, setUserId] = useState(randomUserId);
  const [userEmail, setUserEmail] = useState("");
  const [rows, setRows] = useState<PropRow[]>([]);
  const [propError, setPropError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const nextId = useRef(0);

  // Only fetch trigger presets while the drawer is open (cached + shared with
  // the Journeys view, so it's usually instant).
  const journeysQuery = useQuery({
    queryKey: qk.journeys,
    queryFn: listJourneys,
    enabled: open,
  });
  // Full observed + declared vocabulary for the picker (cached a minute).
  const eventNamesQuery = useQuery({
    queryKey: qk.eventNames,
    queryFn: listEventNames,
    enabled: open,
    staleTime: 60_000,
  });

  const presets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const j of journeysQuery.data?.journeys ?? []) {
      const names = map.get(j.trigger.event) ?? [];
      names.push(j.name);
      map.set(j.trigger.event, names);
    }
    return Array.from(map, ([name, journeys]) => ({ event: name, journeys }));
  }, [journeysQuery.data]);

  const send = useMutation({
    mutationFn: (vars: {
      event: string;
      userId: string;
      userEmail?: string;
      properties: Record<string, unknown>;
    }) => ingestEvent(vars),
    onSuccess: (res) => {
      setResult(res);
      toast({
        title: "Event ingested",
        description: `Stored: ${res.stored} · ${res.exits.length} journey exit(s).`,
      });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Ingest failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const addRow = () =>
    setRows((rs) => [
      ...rs,
      { id: nextId.current++, key: "", type: "string", value: "" },
    ]);

  const handleSend = () => {
    const built = buildProperties(rows);
    if (built.error) {
      setPropError(built.error);
      return;
    }
    setPropError(null);
    send.mutate({
      event: event.trim(),
      userId: userId.trim(),
      userEmail: userEmail.trim() || undefined,
      properties: built.properties,
    });
  };

  const canSend =
    Boolean(event.trim()) && Boolean(userId.trim()) && !send.isPending;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Fire a test event"
      description="POSTs to /v1/admin/events — the same path real events take."
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label>Event name</Label>
          <EventPicker
            ariaLabel="Event name"
            value={event}
            placeholder="e.g. user.created"
            events={eventNamesQuery.data?.events ?? []}
            journeys={(journeysQuery.data?.journeys ?? []).map((j) => ({
              id: j.id,
              name: j.name,
            }))}
            onChange={setEvent}
            allowCustom
          />
          {presets.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {presets.map((p) => (
                <Button
                  key={p.event}
                  variant="outline"
                  size="sm"
                  title={`Triggers: ${p.journeys.join(", ")}`}
                  onClick={() => setEvent(p.event)}
                >
                  {p.event}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="debug-user">User ID</Label>
          <div className="flex gap-2">
            <Input
              id="debug-user"
              placeholder="test_user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              title="Generate a random test user ID"
              aria-label="Generate a random test user ID"
              onClick={() => setUserId(randomUserId())}
            >
              <Shuffle className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="debug-email">User email (optional)</Label>
          <Input
            id="debug-email"
            type="email"
            placeholder="you@example.com"
            value={userEmail}
            onChange={(e) => setUserEmail(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Properties</Label>
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
          <PropertyEditor
            rows={rows}
            onChange={(next) => {
              setRows(next);
              if (propError) setPropError(null);
            }}
          />
          {propError ? (
            <p className="text-xs text-accent">{propError}</p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSend} disabled={!canSend}>
            <Zap className="h-4 w-4" />
            {send.isPending ? "Sending…" : "Send event"}
          </Button>
        </div>

        {result ? (
          <div className="space-y-3 border-t border-hairline-faint pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-white/90" />
              <Badge variant={result.stored ? "default" : "secondary"}>
                {result.stored ? "Stored" : "Not stored"}
              </Badge>
              <span className="text-sm text-white/60">
                {result.exits.length} journey exit(s)
              </span>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border border-hairline-faint bg-white/[0.04] p-3 font-mono text-xs text-white/90">
              {JSON.stringify(result, null, 2)}
            </pre>
            <p className="text-sm text-white/60">
              See the effect in{" "}
              <Link
                to="/journeys"
                onClick={onClose}
                className="text-white hover:text-white/80"
              >
                Journeys
              </Link>{" "}
              or a{" "}
              <Link
                to="/contacts"
                onClick={onClose}
                className="text-white hover:text-white/80"
              >
                contact's timeline
              </Link>
              . Make sure the worker is running.
            </p>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
