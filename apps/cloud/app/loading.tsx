/**
 * The loading state for every route that renders on the server.
 *
 * One file at the root rather than a copy per dashboard page: Next uses the
 * nearest `loading.tsx`, and a skeleton per page would be four identical files
 * drifting apart. It is deliberately CONTENT-SHAPED, not a spinner — the pages
 * that take a moment (overview, environments, settings) all resolve to a header
 * plus a table, so this holds their space instead of collapsing the layout and
 * bouncing it back.
 *
 * No copy: a "Loading…" string would be the only text on screen for the ~100ms
 * a database read takes, and a phrase that flashes is noise, not information.
 */
function Bar({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-[3px] bg-white/[0.06] ${className}`}
    />
  );
}

export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      className="flex flex-1 flex-col"
    >
      <header className="border-white/[0.08] border-b">
        <div className="container-page flex flex-col gap-4 py-7">
          <Bar className="h-7 w-48" />
          <Bar className="h-4 w-full max-w-xl" />
        </div>
      </header>

      <div className="container-page section-py">
        <div className="rounded-md border border-white/[0.08] bg-white/[0.015] p-5">
          <div className="flex flex-col gap-5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center justify-between">
                <Bar className="h-4 w-40" />
                <Bar className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
