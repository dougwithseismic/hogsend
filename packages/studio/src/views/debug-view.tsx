import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Shuffle, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/components/ui/toast";
import {
  type IngestResult,
  ingestEvent,
  listJourneys,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";

function randomUserId(): string {
  return `test_${Math.random().toString(36).slice(2, 10)}`;
}

type ParsedProps =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function parseProps(text: string): ParsedProps {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(trimmed);
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "Properties must be a JSON object." };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Invalid JSON.",
    };
  }
}

/**
 * Debug / test-event panel. Fires events straight into POST /v1/ingest — the
 * exact path real events take — so journeys can be exercised locally without a
 * PostHog tunnel. Event presets are derived from the registered journeys'
 * triggers, so picking one is guaranteed to enrol someone.
 */
export function DebugView() {
  const { toast } = useToast();
  const [event, setEvent] = useState("");
  const [userId, setUserId] = useState(randomUserId);
  const [userEmail, setUserEmail] = useState("");
  const [propsText, setPropsText] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  const journeysQuery = useQuery({
    queryKey: qk.journeys,
    queryFn: listJourneys,
  });

  // Distinct trigger events from registered journeys → "this will fire a journey".
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

  const handleSend = () => {
    const parsed = parseProps(propsText);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }
    setJsonError(null);
    send.mutate({
      event: event.trim(),
      userId: userId.trim(),
      userEmail: userEmail.trim() || undefined,
      properties: parsed.value,
    });
  };

  const canSend =
    Boolean(event.trim()) && Boolean(userId.trim()) && !send.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Debug"
        description="Fire events into the ingest pipeline — exactly what real events do. Trigger journeys locally without a PostHog tunnel."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Send a test event</CardTitle>
            <CardDescription>
              POSTs to <code className="text-xs">/v1/ingest</code>. Journeys
              whose trigger matches will enrol this user.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="event">Event name</Label>
              <Input
                id="event"
                list="event-presets"
                placeholder="e.g. user.created"
                value={event}
                onChange={(e) => setEvent(e.target.value)}
              />
              <datalist id="event-presets">
                {presets.map((p) => (
                  <option key={p.event} value={p.event} />
                ))}
              </datalist>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="userId">User ID</Label>
                <div className="flex gap-2">
                  <Input
                    id="userId"
                    placeholder="test_user"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    title="Generate a random test user ID"
                    onClick={() => setUserId(randomUserId())}
                  >
                    <Shuffle className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="userEmail">User email (optional)</Label>
                <Input
                  id="userEmail"
                  type="email"
                  placeholder="you@example.com"
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="props">Properties (JSON)</Label>
              <textarea
                id="props"
                spellCheck={false}
                className="flex min-h-[140px] w-full rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-sm text-white transition-colors duration-200 placeholder:text-white/40 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                value={propsText}
                onChange={(e) => {
                  setPropsText(e.target.value);
                  if (jsonError) setJsonError(null);
                }}
              />
              {jsonError ? (
                <p className="text-xs text-accent">{jsonError}</p>
              ) : null}
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSend} disabled={!canSend}>
                <Zap className="h-4 w-4" />
                {send.isPending ? "Sending…" : "Send event"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Journey triggers</CardTitle>
              <CardDescription>
                Events that enrol a registered journey. Click to fill the form.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {presets.length === 0 ? (
                <p className="text-sm text-white/60">
                  No journeys registered yet. Any event name still works —
                  define a journey to see triggers here.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
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
              )}
            </CardContent>
          </Card>

          {result ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CheckCircle2 className="h-4 w-4 text-white/90" />
                  Result
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
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
                    className="text-white transition-colors duration-200 hover:text-white/80"
                  >
                    Journeys
                  </Link>{" "}
                  or the{" "}
                  <Link
                    to="/contacts"
                    className="text-white transition-colors duration-200 hover:text-white/80"
                  >
                    contact's timeline
                  </Link>
                  . Make sure the worker is running.
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
