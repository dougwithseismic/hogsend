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
import { signIn, signUp } from "@/lib/auth-client";

type FormMode = "login" | "setup";

function AuthCard({
  mode,
  onSuccess,
}: {
  mode: FormMode;
  onSuccess: () => void;
}) {
  const isSetup = mode === "setup";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
            <label className="text-sm font-medium" htmlFor="password">
              Password
            </label>
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

export function AuthScreen({
  mode,
  onSuccess,
}: {
  mode: FormMode;
  onSuccess: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-muted/30 p-6">
      <AuthCard mode={mode} onSuccess={onSuccess} />
    </div>
  );
}
