import { FileQuestion } from "lucide-react";
import type { Metadata } from "next";
import { Button } from "@/components/ds/button";
import { EmptyState } from "@/components/ds/empty-state";

export const metadata: Metadata = { title: "Page not found" };

/**
 * The 404. Also what `/api-docs` renders in production, where the page calls
 * `notFound()` on purpose — so the copy stays neutral about WHY a route is
 * missing rather than claiming it was mistyped.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <EmptyState
          icon={
            <FileQuestion aria-hidden className="size-5" strokeWidth={1.75} />
          }
          title="No page at this address"
          description="This control plane has no route here. Some pages also exist only in development, so a link that worked locally can be absent in production."
          actions={
            <>
              <Button href="/">Go to the overview</Button>
              <Button href="/environments" variant="outline">
                Environments
              </Button>
            </>
          }
        />
      </div>
    </main>
  );
}
