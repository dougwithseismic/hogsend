import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getVoiceAgentPreview,
  qk,
  type VoiceAgentCatalogEntry,
} from "@/lib/admin-api";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="eyebrow text-white/50">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-hairline-faint bg-white/[0.015] p-3 font-mono text-white/80 text-xs leading-relaxed">
      {children}
    </pre>
  );
}

export function VoiceAgentDetail({ agent }: { agent: VoiceAgentCatalogEntry }) {
  const preview = useQuery({
    queryKey: qk.voiceAgentPreview(agent.key),
    queryFn: () => getVoiceAgentPreview(agent.key),
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-white text-xl tracking-[-0.02em]">
            {agent.key}
          </h2>
          {agent.category ? (
            <Badge variant="secondary">{agent.category}</Badge>
          ) : null}
        </div>
        {agent.description ? (
          <p className="text-sm text-white/60">{agent.description}</p>
        ) : null}
      </div>

      {preview.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
      ) : preview.data ? (
        <div className="space-y-4">
          {/* Voice / model selection */}
          <div className="flex flex-wrap gap-2">
            {preview.data.config.voice ? (
              <Badge variant="outline">
                voice:{" "}
                {String(
                  (preview.data.config.voice as { provider?: unknown })
                    .provider ?? "default",
                )}
                {(preview.data.config.voice as { voiceId?: unknown }).voiceId
                  ? `/${String((preview.data.config.voice as { voiceId?: unknown }).voiceId)}`
                  : ""}
              </Badge>
            ) : null}
            {preview.data.config.model ? (
              <Badge variant="outline">
                model:{" "}
                {String(
                  (preview.data.config.model as { model?: unknown }).model ??
                    "default",
                )}
              </Badge>
            ) : null}
            {preview.data.config.maxDurationSec ? (
              <Badge variant="outline">
                max {preview.data.config.maxDurationSec}s
              </Badge>
            ) : null}
          </div>

          {preview.data.config.firstMessage ? (
            <Section title="First message">
              <Mono>{preview.data.config.firstMessage}</Mono>
            </Section>
          ) : null}

          <Section title="System prompt">
            <Mono>{preview.data.config.systemPrompt}</Mono>
          </Section>

          {preview.data.config.tools?.length ? (
            <Section title={`Tools (${preview.data.config.tools.length})`}>
              <Mono>{JSON.stringify(preview.data.config.tools, null, 2)}</Mono>
            </Section>
          ) : null}

          {preview.data.config.dataSchema ? (
            <Section title="Data collection schema">
              <Mono>
                {JSON.stringify(preview.data.config.dataSchema, null, 2)}
              </Mono>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
