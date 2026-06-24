import { Outlet } from "@tanstack/react-router";
import { LogOut, Zap } from "lucide-react";
import { useCallback, useState } from "react";
import { DebugDrawer, FireEventContext } from "@/components/debug/debug-drawer";
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth-client";
import { Sidebar } from "./sidebar";

export function AppShell() {
  const { data: session } = useSession();
  // Debug is a global drawer (not a page) so a test event can be fired from
  // anywhere without leaving the current view. The opener is shared via context
  // so descendant views (e.g. the Overview CTA) can trigger it too.
  const [debugOpen, setDebugOpen] = useState(false);
  const fireEvent = useCallback(() => setDebugOpen(true), []);

  return (
    <div className="flex h-full bg-ink text-white">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end gap-3 border-b border-hairline-faint bg-ink/30 px-6 backdrop-blur-[7px]">
          <Button variant="outline" size="sm" onClick={fireEvent}>
            <Zap strokeWidth={1.5} className="h-4 w-4" />
            Fire event
          </Button>
          {session?.user ? (
            <span className="text-sm text-white/50">{session.user.email}</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut strokeWidth={1.5} className="h-4 w-4" />
            Sign out
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <FireEventContext.Provider value={fireEvent}>
            <Outlet />
          </FireEventContext.Provider>
        </main>
      </div>
      <DebugDrawer open={debugOpen} onClose={() => setDebugOpen(false)} />
    </div>
  );
}
