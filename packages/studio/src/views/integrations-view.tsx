import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  Plug,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import {
  CardsSkeleton,
  EmptyState,
  ErrorState,
  PageHeader,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  type DiscordConnectInfo,
  disconnectIntegration,
  getDiscordConnectInfo,
  type Integration,
  type IntegrationTransport,
  listIntegrations,
  qk,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/**
 * Integrations page — observe-and-connect, never author. It lists every
 * code-registered inbound connector + outbound destination, shows whether each
 * has a stored credential, and offers connect (invite-bot / via-CLI) +
 * disconnect. The actual SECRET paste happens via `hogsend connect <provider>`
 * (the CLI), so Studio never accepts a token.
 */

const TRANSPORT_LABEL: Record<IntegrationTransport, string> = {
  webhook: "Webhook",
  gateway: "Gateway",
  poll: "Poll",
};

function TransportBadge({ transport }: { transport: IntegrationTransport }) {
  return (
    <Badge variant="secondary" className="font-mono text-[11px]">
      {TRANSPORT_LABEL[transport]}
    </Badge>
  );
}

function ConnectedBadge({
  credential,
}: {
  credential: Integration["credential"];
}) {
  if (credential?.connected) {
    return (
      <Badge
        variant="outline"
        className="border-white/15 bg-white/[0.06] text-white/80"
      >
        Connected
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-white/50">
      Not connected
    </Badge>
  );
}

function FaceBadges({ integration }: { integration: Integration }) {
  return (
    <div className="flex flex-wrap gap-1">
      {integration.hasConnector ? (
        <Badge variant="outline" className="text-white/60">
          Inbound
        </Badge>
      ) : null}
      {integration.hasDestination ? (
        <Badge variant="outline" className="text-white/60">
          Outbound
        </Badge>
      ) : null}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0 text-white/50">{label}</span>
      <code className="flex-1 truncate rounded border border-hairline-faint bg-white/[0.04] px-2 py-1 font-mono text-white/70">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            toast({ title: "Copied", description: `${label} copied.` });
          });
        }}
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
      </Button>
    </div>
  );
}

/** Decode the privileged-intent bitfield into human chips. */
const INTENT_CHIPS: { bit: number; label: string }[] = [
  { bit: 1 << 1, label: "Members" },
  { bit: 1 << 8, label: "Presence" },
  { bit: 1 << 9, label: "Messages" },
  { bit: 1 << 10, label: "Reactions" },
  { bit: 1 << 15, label: "Message content" },
];

function IntentChips({ intents }: { intents: number }) {
  const active = INTENT_CHIPS.filter((c) => (intents & c.bit) !== 0);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((c) => (
        <Badge key={c.label} variant="secondary" className="text-[11px]">
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

function MemberStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-hairline-faint bg-white/[0.015] px-3 py-2">
      <p className="font-display text-lg text-white tabular-nums">{value}</p>
      <p className="text-[11px] text-white/50">{label}</p>
    </div>
  );
}

/** The Discord (gateway) card body — invite bot, intents, member counts. */
function DiscordCardBody({
  integration,
  connectInfo,
}: {
  integration: Integration;
  connectInfo: DiscordConnectInfo | undefined;
}) {
  const gateway = integration.gateway;
  const credentialStored = Boolean(integration.credential?.connected);
  const installUrl = connectInfo?.installUrl ?? null;

  return (
    <div className="space-y-4">
      {!credentialStored ? (
        <div className="rounded-md border border-accent/40 bg-accent-tint p-3 text-xs text-white/70">
          <p className="font-medium text-accent">Connect via CLI</p>
          <p className="mt-1">
            Discord secrets are pasted through the CLI — Studio never stores
            tokens. Run{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono">
              hogsend connect discord
            </code>{" "}
            to paste the bot token + client secret, then return here to invite
            the bot.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/50">Bot:</span>
        {gateway?.botInstalled === true ? (
          <Badge
            variant="outline"
            className="border-white/15 bg-white/[0.06] text-white/80"
          >
            Installed
          </Badge>
        ) : gateway?.botInstalled === false ? (
          <Badge variant="outline" className="text-white/50">
            Not installed
          </Badge>
        ) : (
          <Badge variant="outline" className="text-white/40">
            Unknown
          </Badge>
        )}
        <span className="text-xs text-white/50">Worker:</span>
        {gateway?.workerHealthy ? (
          <Badge
            variant="outline"
            className="border-white/15 bg-white/[0.06] text-white/80"
          >
            Online
          </Badge>
        ) : (
          <Badge variant="outline" className="text-white/50">
            Offline
          </Badge>
        )}
      </div>

      {gateway?.guildId ? (
        <CopyRow label="Guild" value={gateway.guildId} />
      ) : null}

      {gateway?.intents ? <IntentChips intents={gateway.intents} /> : null}

      {gateway ? (
        <div className="grid grid-cols-2 gap-2">
          <MemberStat label="Linked members" value={gateway.linkedMembers} />
          <MemberStat
            label="Unlinked members"
            value={gateway.unlinkedMembers}
          />
        </div>
      ) : null}

      {installUrl ? (
        <a href={installUrl} target="_blank" rel="noreferrer">
          <Button variant="secondary" size="sm" className="w-full">
            <Plug className="h-4 w-4" strokeWidth={1.5} />
            {gateway?.botInstalled ? "Re-invite bot" : "Invite bot"}
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60" />
          </Button>
        </a>
      ) : null}
    </div>
  );
}

/** Webhook-transport card body — inbound URL + verify-secret state. */
function WebhookCardBody({ integration }: { integration: Integration }) {
  const webhook = integration.webhook;
  if (!webhook) return null;
  return (
    <div className="space-y-3">
      <CopyRow label="URL" value={webhook.url} />
      <div className="flex items-center gap-2 text-xs">
        <span className="text-white/50">Verify secret:</span>
        {webhook.secretConfigured ? (
          <Badge
            variant="outline"
            className="border-white/15 bg-white/[0.06] text-white/80"
          >
            Configured
          </Badge>
        ) : (
          <Badge variant="destructive">Open — no secret</Badge>
        )}
      </div>
    </div>
  );
}

function IntegrationCard({
  integration,
  connectInfo,
  onDisconnect,
}: {
  integration: Integration;
  connectInfo: DiscordConnectInfo | undefined;
  onDisconnect: (integration: Integration) => void;
}) {
  const isDiscord = integration.id === "discord";
  const connected = Boolean(integration.credential?.connected);

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            {integration.transport === "webhook" ? (
              <Webhook className="h-4 w-4 text-white/40" strokeWidth={1.5} />
            ) : (
              <Plug className="h-4 w-4 text-white/40" strokeWidth={1.5} />
            )}
            <CardTitle>{integration.name}</CardTitle>
          </div>
          <ConnectedBadge credential={integration.credential} />
        </div>
        {integration.description ? (
          <p className="text-sm text-white/60">{integration.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <TransportBadge transport={integration.transport} />
          <FaceBadges integration={integration} />
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        {isDiscord ? (
          <DiscordCardBody
            integration={integration}
            connectInfo={connectInfo}
          />
        ) : integration.transport === "webhook" ? (
          <WebhookCardBody integration={integration} />
        ) : null}

        {integration.credential?.updatedAt ? (
          <p className="text-[11px] text-white/40">
            Connected {formatDateTime(integration.credential.updatedAt)}
          </p>
        ) : null}

        {connected ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => onDisconnect(integration)}
          >
            Disconnect
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function IntegrationsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [disconnectTarget, setDisconnectTarget] = useState<Integration | null>(
    null,
  );

  const query = useQuery({
    queryKey: qk.integrations,
    queryFn: listIntegrations,
  });

  // Discord connect-info is its own small projection (install URL, readiness).
  // Fetched alongside; a 404/501 (no discord registered) is non-fatal — the
  // card simply hides the invite button.
  const discordInfo = useQuery({
    queryKey: qk.discordConnectInfo,
    queryFn: getDiscordConnectInfo,
    retry: false,
  });

  const disconnect = useMutation({
    mutationFn: (providerId: string) => disconnectIntegration(providerId),
    onSuccess: () => {
      toast({ title: "Integration disconnected" });
      setDisconnectTarget(null);
      void queryClient.invalidateQueries({ queryKey: qk.integrations });
      void queryClient.invalidateQueries({ queryKey: qk.discordConnectInfo });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Disconnect failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setDisconnectTarget(null);
    },
  });

  const integrations = query.data?.integrations ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Code-registered connectors and destinations. Connect via the CLI, then observe and manage here."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="h-4 w-4" />
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {query.isPending ? (
        <CardsSkeleton count={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : integrations.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No integrations registered"
          description="Register a connector or destination in code, then it appears here to connect."
          action={
            <a
              href="https://docs.hogsend.com/docs/guides/events"
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="outline" size="sm">
                <ExternalLink className="h-4 w-4" />
                Connector docs
              </Button>
            </a>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              connectInfo={
                integration.id === "discord" ? discordInfo.data : undefined
              }
              onDisconnect={setDisconnectTarget}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={disconnectTarget !== null}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() =>
          disconnectTarget && disconnect.mutate(disconnectTarget.id)
        }
        title="Disconnect this integration?"
        description={
          disconnectTarget
            ? `Purges all stored credentials for "${disconnectTarget.name}" — the OAuth grant and any derived config. The bot stays in your server until you remove it there. This cannot be undone.`
            : undefined
        }
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
      />
    </div>
  );
}
