import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getTemplatePreview, qk } from "@/lib/admin-api";

/** Sandboxed render of one template — shared by the journey + campaign pages. */
export function TemplatePreviewFrame({ templateKey }: { templateKey: string }) {
  const preview = useQuery({
    queryKey: qk.templatePreview(templateKey),
    queryFn: () => getTemplatePreview(templateKey),
  });

  if (preview.isPending) return <Skeleton className="h-[400px] w-full" />;
  if (preview.isError) {
    return (
      <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-white">
      <iframe
        title={`${templateKey} preview`}
        srcDoc={preview.data.html}
        sandbox=""
        className="h-[600px] w-full"
      />
    </div>
  );
}
