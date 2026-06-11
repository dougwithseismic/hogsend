import { type ReactNode, useState } from "react";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requestPasswordReset, resetPassword, signIn } from "@/lib/auth-client";

export type FormMode = "login" | "forgot" | "reset";

/**
 * Where better-auth redirects the browser after the user clicks the reset link
 * in their email. better-auth appends `?token=…`; the {@link AuthGate} reads that
 * token and renders the `reset` view. We point at the Studio mount (`/studio`)
 * on the current origin so the redirect lands back inside the SPA.
 */
function resetRedirectUrl(): string {
  if (typeof window === "undefined") return "/studio";
  return `${window.location.origin}/studio`;
}

// ---------------------------------------------------------------------------
// Shell — centered brand lockup over a glass card on the ink page
// ---------------------------------------------------------------------------

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 bg-ink p-6">
      <div className="flex flex-col items-center gap-3">
        <Logo />
        <span className="eyebrow text-white/50">Studio</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login (credentials)
// ---------------------------------------------------------------------------

function CredentialsCard({
  onSuccess,
  onForgot,
}: {
  onSuccess: () => void;
  onForgot: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="glass-panel w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to Studio</CardTitle>
        <CardDescription>
          Enter your credentials to access Hogsend Studio.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-white/80"
              htmlFor="email"
            >
              Email
            </label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                className="text-sm font-medium text-white/80"
                htmlFor="password"
              >
                Password
              </label>
              <button
                type="button"
                onClick={onForgot}
                className="text-white/50 text-xs transition-colors duration-200 hover:text-white"
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          {error ? <p className="text-sm text-accent">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Please wait…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// No admin yet — info screen (no form, no network path to create a user)
// ---------------------------------------------------------------------------

/**
 * Shown when `GET /v1/auth/status` reports `needsSetup` (zero users). Public
 * sign-up is closed, so this is a read-only INFO card: the first admin is
 * created from the server (CLI or env bootstrap), never over the network. A
 * Reload button re-probes the status so the operator can refresh after minting.
 */
export function SetupNeededCard({ onReload }: { onReload: () => void }) {
  return (
    <Card className="glass-panel w-full max-w-md">
      <CardHeader>
        <CardTitle>No admin exists yet</CardTitle>
        <CardDescription>
          Create the first admin from your server — there is no sign-up over the
          web.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm text-white/60">
          <p>Run the CLI where your app is deployed:</p>
          <pre className="rounded-md border border-hairline-faint bg-white/[0.04] p-3 font-mono text-white/90 text-xs">
            <code>hogsend studio admin create</code>
          </pre>
          <p>
            …or set <code>STUDIO_ADMIN_EMAIL</code> (and optionally{" "}
            <code>STUDIO_ADMIN_PASSWORD</code>) in your environment and restart
            the API. If you didn't set a password, one is printed once to the
            server log.
          </p>
          <p>Then reload this page.</p>
        </div>
        <Button type="button" className="w-full" onClick={onReload}>
          Reload
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Forgot password (request the reset email)
// ---------------------------------------------------------------------------

function ForgotCard({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Neutral success: shown whether or not the email exists (no enumeration).
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // The server always returns a neutral response (no enumeration). Surface
      // the same neutral message regardless of the result.
      await requestPasswordReset({
        email,
        redirectTo: resetRedirectUrl(),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="glass-panel w-full max-w-sm">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your account email and we'll send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-white/60">
              If that email matches an account, a reset link is on its way. The
              link expires in 15 minutes and can be used once.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={onBack}
            >
              Back to sign in
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-white/80"
                htmlFor="forgot-email"
              >
                Email
              </label>
              <Input
                id="forgot-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            {error ? <p className="text-sm text-accent">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="w-full text-center text-white/50 text-xs transition-colors duration-200 hover:text-white"
            >
              Back to sign in
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reset password (consume the token from the reset link)
// ---------------------------------------------------------------------------

function ResetCard({ token, onBack }: { token: string; onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(
          result.error.message ??
            "This reset link is invalid or has expired. Request a new one.",
        );
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="glass-panel w-full max-w-sm">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          {done
            ? "Your password has been updated."
            : "Enter a new password for your account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <Button type="button" className="w-full" onClick={onBack}>
            Back to sign in
          </Button>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-white/80"
                htmlFor="new-password"
              >
                New password
              </label>
              <Input
                id="new-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-white/80"
                htmlFor="confirm-password"
              >
                Confirm password
              </label>
              <Input
                id="confirm-password"
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
            {error ? <p className="text-sm text-accent">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="w-full text-center text-white/50 text-xs transition-colors duration-200 hover:text-white"
            >
              Back to sign in
            </button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Screen shell — routes the active mode to the right card
// ---------------------------------------------------------------------------

export function AuthScreen({
  mode,
  onSuccess,
  onModeChange,
  resetToken,
}: {
  mode: FormMode;
  onSuccess: () => void;
  /** Switch the visible card (login ↔ forgot ↔ reset). */
  onModeChange?: (mode: FormMode) => void;
  /** The `?token=` extracted from the reset link, required for `reset` mode. */
  resetToken?: string;
}) {
  const goLogin = () => onModeChange?.("login");

  let card: React.ReactNode;
  if (mode === "forgot") {
    card = <ForgotCard onBack={goLogin} />;
  } else if (mode === "reset") {
    card = resetToken ? (
      <ResetCard token={resetToken} onBack={goLogin} />
    ) : (
      <ForgotCard onBack={goLogin} />
    );
  } else {
    card = (
      <CredentialsCard
        onSuccess={onSuccess}
        onForgot={() => onModeChange?.("forgot")}
      />
    );
  }

  return <AuthShell>{card}</AuthShell>;
}
