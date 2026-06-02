import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getAuthStatus } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { AuthScreen } from "./auth-forms";

function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Gates the app behind authentication.
 *
 * 1. Probe GET /v1/auth/status. If `needsSetup`, show the create-admin form.
 * 2. Otherwise read the Better Auth session. If absent, show the login form.
 * 3. With a session present, render the children (the authed app shell).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const {
    data: status,
    isPending: statusPending,
    isError: statusError,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: ["auth-status"],
    queryFn: getAuthStatus,
    retry: 1,
    staleTime: 0,
  });

  const {
    data: session,
    isPending: sessionPending,
    refetch: refetchSession,
  } = useSession();

  if (statusPending) {
    return <FullScreenMessage>Loading…</FullScreenMessage>;
  }

  if (statusError) {
    return (
      <FullScreenMessage>Unable to reach the Hogsend API.</FullScreenMessage>
    );
  }

  if (status?.needsSetup) {
    return (
      <AuthScreen
        mode="setup"
        onSuccess={() => {
          void refetchStatus();
          void refetchSession();
        }}
      />
    );
  }

  if (sessionPending) {
    return <FullScreenMessage>Loading…</FullScreenMessage>;
  }

  if (!session?.user) {
    return (
      <AuthScreen
        mode="login"
        onSuccess={() => {
          void refetchSession();
        }}
      />
    );
  }

  return <>{children}</>;
}
