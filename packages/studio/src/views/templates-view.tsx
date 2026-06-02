import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { listTemplates, qk } from "@/lib/admin-api";
import { cn } from "@/lib/utils";
import { TemplateDetail } from "./templates/template-detail";

export function TemplatesView() {
  const query = useQuery({ queryKey: qk.templates, queryFn: listTemplates });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const templates = query.data?.templates ?? [];

  // Auto-select the first template once the catalog loads.
  useEffect(() => {
    const first = templates[0];
    if (selectedKey === null && first) {
      setSelectedKey(first.key);
    }
  }, [selectedKey, templates]);

  const selected = templates.find((t) => t.key === selectedKey) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description="Catalog, per-template stats, live previews, and send-test."
      />

      {query.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : templates.length === 0 ? (
        <EmptyState
          title="No templates registered"
          description="Templates appear here once they're added to your email registry."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <nav className="space-y-1">
            {templates.map((t) => (
              <button
                type="button"
                key={t.key}
                onClick={() => setSelectedKey(t.key)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm transition-colors",
                  t.key === selectedKey
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <span className="block font-medium">{t.key}</span>
                {t.category ? (
                  <span className="block text-xs opacity-70">{t.category}</span>
                ) : null}
              </button>
            ))}
          </nav>
          {selected ? (
            <TemplateDetail key={selected.key} template={selected} />
          ) : null}
        </div>
      )}
    </div>
  );
}
