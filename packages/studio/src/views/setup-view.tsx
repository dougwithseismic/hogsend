import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  addDomain,
  type DomainVerificationState,
  type EngineDomainStatus,
  getDomainStatus,
  qk,
  type TestModeState,
  verifyDomain,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/** Pinned domain validation regex — mirrors the engine's admin route. */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const STATE_STYLES: Record<
  DomainVerificationState,
  { variant: BadgeProps["variant"]; className?: string }
> = {
  verified: {
    variant: "outline",
    className: "border-white/15 bg-white/[0.06] text-white/80",
  },
  pending: { variant: "secondary" },
  failed: { variant: "destructive" },
  not_found: { variant: "outline" },
};

function StateBadge({ state }: { state: DomainVerificationState }) {
  const style = STATE_STYLES[state];
  return (
    <Badge variant={style.variant} className={style.className}>
      {state.replace("_", " ")}
    </Badge>
  );
}

/**
 * Test-mode banner — renders ONLY when active. F1 ships test mode stubbed
 * inactive, so this shows nothing today; F3 test-mode-sends lights it up with
 * zero Studio changes.
 */
function TestModeBanner({ testMode }: { testMode: TestModeState }) {
  if (!testMode.active) return null;
  return (
    <div className="rounded-md border border-accent/40 bg-accent-tint p-4 text-sm">
      <p className="font-medium text-accent">
        Test mode is active
        {testMode.reason === "domain_unverified"
          ? " — sending domain not verified"
          : testMode.reason === "env_flag"
            ? " — forced via HOGSEND_TEST_MODE"
            : ""}
      </p>
      <p className="mt-1 text-white/60">
        {testMode.redirectTo
          ? `All sends are redirected to ${testMode.redirectTo}.`
          : "No redirect address is configured — sends will fail until one is set."}
        {testMode.fromOverride
          ? ` From address is overridden to ${testMode.fromOverride}.`
          : ""}
      </p>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const { toast } = useToast();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Copy value"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          toast({ title: "Copied", description: "Value copied to clipboard." });
        });
      }}
    >
      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
    </Button>
  );
}

function AddDomainForm({
  onSubmit,
  loading,
}: {
  onSubmit: (domain: string) => void;
  loading: boolean;
}) {
  const [domain, setDomain] = useState("");
  const valid = DOMAIN_RE.test(domain);
  return (
    <form
      className="flex max-w-md items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(domain.toLowerCase());
      }}
    >
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="setup-domain">Sending domain</Label>
        <Input
          id="setup-domain"
          placeholder="mysite.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={!valid || loading}>
        {loading ? "Adding…" : "Add domain"}
      </Button>
    </form>
  );
}

export function SetupView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.domain,
    queryFn: () => getDomainStatus(),
  });

  const applyStatus = (status: EngineDomainStatus) => {
    queryClient.setQueryData(qk.domain, status);
  };

  const onMutationError = (title: string) => (error: unknown) => {
    toast({
      variant: "error",
      title,
      description:
        error instanceof ApiError
          ? error.status === 501
            ? "The active email provider does not support domain management."
            : error.message
          : "Unexpected error.",
    });
  };

  const recheck = useMutation({
    mutationFn: () => getDomainStatus(true),
    onSuccess: applyStatus,
    onError: onMutationError("Re-check failed"),
  });

  const verify = useMutation({
    mutationFn: () => verifyDomain(),
    onSuccess: (status) => {
      applyStatus(status);
      toast({
        title: "Verification pass triggered",
        description:
          status.status?.state === "verified"
            ? "Domain is verified."
            : "DNS can take a few minutes — re-check shortly.",
      });
    },
    onError: onMutationError("Verify failed"),
  });

  const add = useMutation({
    mutationFn: (domain: string) => addDomain(domain),
    onSuccess: (status) => {
      applyStatus(status);
      toast({
        title: "Domain registered",
        description: "Add the DNS records below at your DNS host.",
      });
    },
    onError: onMutationError("Add domain failed"),
  });

  const data = query.data;
  const records = data?.status?.records ?? [];
  const needsDomain =
    data?.supported === true &&
    (data.status === null || data.status.state === "not_found");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Setup"
        description="Sending-domain verification — DNS records, status, and test mode."
        action={
          data?.supported ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => recheck.mutate()}
                disabled={recheck.isPending}
              >
                <RefreshCw className="h-4 w-4" />
                {recheck.isPending ? "Checking…" : "Re-check"}
              </Button>
              {data.domain ? (
                <Button
                  size="sm"
                  onClick={() => verify.mutate()}
                  disabled={verify.isPending}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {verify.isPending ? "Verifying…" : "Verify"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !data ? null : !data.supported ? (
        <EmptyState
          icon={Globe}
          title="Domain management not supported"
          description={`The active email provider (${data.providerId}) does not expose a domains API. Verify your sending domain in the provider's own dashboard instead.`}
        />
      ) : (
        <>
          <TestModeBanner testMode={data.testMode} />

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-white/[0.015] p-4 text-sm">
            <span>
              <span className="text-white/60">Domain: </span>
              <span className="font-medium text-white">
                {data.domain ?? "not configured"}
              </span>
            </span>
            <span>
              <span className="text-white/60">Provider: </span>
              <span className="font-medium text-white">{data.providerId}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-white/60">State:</span>
              <StateBadge state={data.status?.state ?? "not_found"} />
            </span>
            {data.status?.checkedAt ? (
              <span className="text-white/50">
                Checked {formatDateTime(data.status.checkedAt)}
              </span>
            ) : null}
          </div>

          {needsDomain ? (
            <div className="space-y-3">
              <p className="text-sm text-white/60">
                {data.domain
                  ? `${data.domain} isn't registered with ${data.providerId} yet — add it to get the DNS records.`
                  : "No sending domain configured. Add one to get the DNS records to verify."}
              </p>
              <AddDomainForm
                onSubmit={(domain) => add.mutate(domain)}
                loading={add.isPending}
              />
            </div>
          ) : null}

          {records.length > 0 ? (
            <div className="rounded-lg border bg-white/[0.015]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="text-right">Priority</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow
                      key={`${record.type}-${record.name}-${record.value}`}
                    >
                      <TableCell className="font-medium text-white">
                        {record.type}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-white/70">
                        <span className="flex items-center gap-1">
                          {record.name}
                          <CopyButton value={record.name} />
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[18rem] font-mono text-xs text-white/70">
                        <span className="flex items-center gap-1">
                          <span className="truncate" title={record.value}>
                            {record.value}
                          </span>
                          <CopyButton value={record.value} />
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-white/60">
                        {record.priority ?? ""}
                      </TableCell>
                      <TableCell className="text-white/60">
                        {record.purpose}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={record.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : !needsDomain ? (
            <EmptyState
              icon={Globe}
              title="No DNS records yet"
              description="The provider hasn't reported any DNS records for this domain. Re-check, or verify it in the provider dashboard."
            />
          ) : null}
        </>
      )}
    </div>
  );
}
