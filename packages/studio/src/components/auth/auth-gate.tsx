import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { getAuthStatus } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { AuthScreen, type FormMode } from "./auth-forms";

function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Read the `?token=` better-auth appends when it redirects the browser back from
 * a reset link (`requestPasswordReset({ redirectTo })`). Returns it once, on the
 * first render, so we can show the reset card. Returns "" when absent.
 */
function readResetTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/**
 * Strip the `?token=` (and any other reset query params) from the URL bar after
 * we've captured it, so the secret doesn't linger in the address bar / history
 * and a refresh doesn't re-trigger the reset view.
 */
function clearResetTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) return;
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.toString());
}

/**
 * Gates the app behind authentication.
 *
 * 1. If the URL carries a reset `?token=`, show the reset-password card.
 * 2. Probe GET /v1/auth/status. If `needsSetup`, show the create-admin form.
 * 3. Otherwise read the Better Auth session. If absent, show the login form
 *    (with a "Forgot password?" link → the reset-request card).
 * 4. With a session present, render the children (the authed app shell).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // Capture the reset token ONCE on mount, then clear it from the URL bar so the
  // secret doesn't linger in history. If present, we open straight into `reset`.
  const [resetToken] = useState(() => {
    const token = readResetTokenFromUrl();
    if (token) clearResetTokenFromUrl();
    return token;
  });
  const [mode, setMode] = useState<FormMode | null>(() =>
    resetToken ? "reset" : null,
  );

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

  // The reset card stands on its own — render it before the status/session
  // probes so a logged-out user clicking a reset link always lands on it.
  if (mode === "reset" || mode === "forgot") {
    return (
      <AuthScreen
        mode={mode}
        resetToken={resetToken}
        onModeChange={setMode}
        onSuccess={() => {
          void refetchSession();
        }}
      />
    );
  }

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
        onModeChange={setMode}
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
        onModeChange={setMode}
        onSuccess={() => {
          void refetchSession();
        }}
      />
    );
  }

  return <>{children}</>;
}
