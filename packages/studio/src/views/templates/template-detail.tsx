import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { BarChart } from "@/components/bar-chart";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  getTemplatePreview,
  getTemplateReport,
  qk,
  sendTestEmail,
  type TemplateCatalogEntry,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { formatNumber, formatPercent } from "@/lib/format";

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

export function TemplateDetail({
  template,
}: {
  template: TemplateCatalogEntry;
}) {
  const { toast } = useToast();
  const [testOpen, setTestOpen] = useState(false);
  const [to, setTo] = useState("");

  const preview = useQuery({
    queryKey: qk.templatePreview(template.key),
    queryFn: () => getTemplatePreview(template.key),
  });

  const report = useQuery({
    queryKey: qk.templateReport(template.key),
    queryFn: () => getTemplateReport(template.key),
    // A template that's never been sent returns 404 — don't retry that.
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const sendTest = useMutation({
    mutationFn: () => sendTestEmail(template.key, to),
    onSuccess: (res) => {
      toast({
        title: "Test email sent",
        description: `Status: ${res.status}.`,
      });
      setTestOpen(false);
      setTo("");
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Send-test failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
    },
  });

  const reportNotFound =
    report.isError &&
    report.error instanceof ApiError &&
    report.error.status === 404;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {template.key}
            </h2>
            {template.category ? (
              <Badge variant="secondary">{template.category}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {template.defaultSubject}
          </p>
        </div>
        <Button onClick={() => setTestOpen(true)}>
          <Send className="h-4 w-4" />
          Send test
        </Button>
      </div>

      {/* Report totals + series */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Performance</h3>
        {report.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : reportNotFound ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This template has never been sent.
          </p>
        ) : report.isError ? (
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        ) : report.data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Sent"
                value={formatNumber(report.data.totals.sent)}
              />
              <Metric
                label="Delivered"
                value={formatNumber(report.data.totals.delivered)}
              />
              <Metric
                label="Open rate"
                value={formatPercent(report.data.totals.openRate)}
              />
              <Metric
                label="Click rate"
                value={formatPercent(report.data.totals.clickRate)}
              />
            </div>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Sends over time
                </CardTitle>
              </CardHeader>
              <CardContent>
                <BarChart
                  label="sent"
                  data={report.data.series.map((p) => ({
                    date: p.date,
                    value: p.sent,
                  }))}
                />
              </CardContent>
            </Card>
          </>
        ) : null}
      </section>

      {/* Rendered preview */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Preview</h3>
        {preview.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : preview.isError ? (
          <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
        ) : preview.data ? (
          <div className="overflow-hidden rounded-lg border bg-white">
            <iframe
              title={`${template.key} preview`}
              srcDoc={preview.data.html}
              sandbox=""
              className="h-[600px] w-full"
            />
          </div>
        ) : null}
      </section>

      <Dialog
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title="Send a test email"
        description={`Sends "${template.key}" with example props.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setTestOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => sendTest.mutate()}
              disabled={!to || sendTest.isPending}
            >
              {sendTest.isPending ? "Sending…" : "Send test"}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="test-to">Recipient email</Label>
          <Input
            id="test-to"
            type="email"
            placeholder="you@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
