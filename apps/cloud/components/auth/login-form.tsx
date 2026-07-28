"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ds/button";
import { Field, FormError, Input } from "@/components/ds/field";
import { authClient } from "@/src/lib/auth-client";

/** `next` is where to land after sign-in — already sanitized by the page. */
export function LoginForm({ next = "/" }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      // Better Auth returns one message for a bad email AND a bad password, so
      // this does not leak which accounts exist.
      setError(signInError.message ?? "Could not sign in.");
      setPending(false);
      return;
    }
    // The session cookie is set; a refresh re-runs the middleware guard, which
    // now allows the destination.
    router.replace(next);
    router.refresh();
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={onSubmit}>
      <FormError>{error}</FormError>
      <Field htmlFor="login-email" label="Email">
        <Input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field htmlFor="login-password" label="Password">
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button
        type="submit"
        disabled={pending}
        className="w-full justify-center"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
