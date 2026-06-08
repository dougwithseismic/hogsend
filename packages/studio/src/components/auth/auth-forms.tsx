import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  requestPasswordReset,
  resetPassword,
  signIn,
  signUp,
} from "@/lib/auth-client";

export type FormMode = "login" | "setup" | "forgot" | "reset";

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
// Login + setup (credentials)
// ---------------------------------------------------------------------------

function CredentialsCard({
  mode,
  onSuccess,
  onForgot,
}: {
  mode: "login" | "setup";
  onSuccess: () => void;
  onForgot: () => void;
}) {
  const isSetup = mode === "setup";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = isSetup
        ? await signUp.email({
            name: name || email,
            email,
            password,
            // The server requires the setup token on the first-admin create.
            // Send it as a header (kept out of the body / better-auth schema);
            // the engine compares it server-side in constant time.
            fetchOptions: {
              headers: { "x-hogsend-setup-token": setupToken },
            },
          })
        : await signIn.email({ email, password });

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
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          {isSetup ? "Create admin account" : "Sign in to Studio"}
        </CardTitle>
        <CardDescription>
          {isSetup
            ? "No users exist yet. Create the first admin to get started."
            : "Enter your credentials to access Hogsend Studio."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {isSetup ? (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="setup-token">
                  Setup token
                </label>
                <Input
                  id="setup-token"
                  required
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  placeholder="Paste the token from your server logs"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Check your server logs for the setup token printed on first
                  boot (or use the <code>STUDIO_SETUP_TOKEN</code> you
                  configured).
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="name">
                  Name
                </label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            </>
          ) : null}
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="email">
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
              <label className="text-sm font-medium" htmlFor="password">
                Password
              </label>
              {!isSetup ? (
                <button
                  type="button"
                  onClick={onForgot}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Forgot password?
                </button>
              ) : null}
            </div>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={isSetup ? "new-password" : "current-password"}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Please wait…" : isSetup ? "Create admin" : "Sign in"}
          </Button>
        </form>
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
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your account email and we'll send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
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
              <label className="text-sm font-medium" htmlFor="forgot-email">
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
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
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
    <Card className="w-full max-w-sm">
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
              <label className="text-sm font-medium" htmlFor="new-password">
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
              <label className="text-sm font-medium" htmlFor="confirm-password">
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
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
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
        mode={mode}
        onSuccess={onSuccess}
        onForgot={() => onModeChange?.("forgot")}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-muted/30 p-6">
      {card}
    </div>
  );
}
