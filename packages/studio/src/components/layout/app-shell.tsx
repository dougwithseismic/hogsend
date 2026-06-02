import { Outlet } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth-client";
import { Sidebar } from "./sidebar";

export function AppShell() {
  const { data: session } = useSession();

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end gap-3 border-b bg-card px-6">
          {session?.user ? (
            <span className="text-sm text-muted-foreground">
              {session.user.email}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void signOut();
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
