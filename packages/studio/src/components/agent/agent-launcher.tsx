import { Sparkles } from "lucide-react";

/**
 * Bottom-right launcher (FAB). Sits below toasts (z-[60]) and the open panel
 * (z-50); hidden while the panel is open. Mirrors the header "Agent" button.
 */
export function AgentLauncher({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: () => void;
}) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the co-working agent"
      className="fixed right-5 bottom-5 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-hairline bg-raised text-accent shadow-black/40 shadow-xl transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Sparkles strokeWidth={1.5} className="h-5 w-5" />
    </button>
  );
}
