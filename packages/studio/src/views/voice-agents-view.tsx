import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { listVoiceAgents, qk } from "@/lib/admin-api";
import { cn } from "@/lib/utils";
import { VoiceAgentDetail } from "./voice-agents/voice-agent-detail";

export function VoiceAgentsView() {
  const query = useQuery({
    queryKey: qk.voiceAgents,
    queryFn: listVoiceAgents,
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const agents = query.data?.agents ?? [];

  // Auto-select the first agent once the catalog loads.
  useEffect(() => {
    const first = agents[0];
    if (selectedKey === null && first) setSelectedKey(first.key);
  }, [selectedKey, agents]);

  const selected = agents.find((a) => a.key === selectedKey) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Voice agents"
        description="Preview the synthesized agent config — prompt, voice, tools, and the data-collection schema handed to the provider on a call."
      />

      {query.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No voice agents registered"
          description="Agents appear here once they're added to your voice registry and a voice provider is configured (voice: { agents } in createHogsendClient)."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <nav className="space-y-1">
            {agents.map((a) => (
              <button
                type="button"
                key={a.key}
                onClick={() => setSelectedKey(a.key)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm transition-colors duration-200",
                  a.key === selectedKey
                    ? "bg-accent-tint text-accent"
                    : "text-white/60 hover:bg-white/5 hover:text-white",
                )}
              >
                <span className="block font-medium">{a.key}</span>
                {a.category ? (
                  <span className="block text-xs opacity-70">{a.category}</span>
                ) : null}
              </button>
            ))}
          </nav>
          {selected ? (
            <VoiceAgentDetail key={selected.key} agent={selected} />
          ) : null}
        </div>
      )}
    </div>
  );
}
