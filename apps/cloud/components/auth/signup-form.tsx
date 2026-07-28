"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ds/button";
import { Field, FormError, Input } from "@/components/ds/field";
import { authClient } from "@/src/lib/auth-client";

type Step = "credentials" | "verify";

/**
 * Two steps in one component because they share the credentials: sign-up does
 * NOT create a session (`autoSignIn: false`), so after the OTP is accepted we
 * sign in with the password already in state rather than asking for it twice.
 */
export function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
    });
    setPending(false);
    if (signUpError) {
      setError(signUpError.message ?? "Could not create the account.");
      return;
    }
    setStep("verify");
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const { error: verifyError } = await authClient.emailOtp.verifyEmail({
      email,
      otp,
    });
    if (verifyError) {
      setError(verifyError.message ?? "That code was not accepted.");
      setPending(false);
      return;
    }

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      // The account IS verified at this point — only the session failed, so
      // send them to the login screen rather than back through sign-up.
      setError(`${signInError.message ?? "Sign-in failed"}. Try signing in.`);
      setPending(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  async function onResend() {
    setError(null);
    setNotice(null);
    const { error: resendError } =
      await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      });
    if (resendError) {
      setError(resendError.message ?? "Could not send a new code.");
      return;
    }
    setNotice("A new code is on its way.");
  }

  if (step === "verify") {
    return (
      <form className="flex flex-col gap-5" onSubmit={onVerify}>
        <FormError>{error}</FormError>
        {notice ? (
          <p className="text-sm text-white/60 leading-6">{notice}</p>
        ) : null}
        <Field
          htmlFor="signup-otp"
          label="Verification code"
          hint={`Six digits, sent to ${email}. The code expires in 10 minutes.`}
        >
          <Input
            id="signup-otp"
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={otp}
            onChange={(e) => setOtp(e.target.value.trim())}
          />
        </Field>
        <Button
          type="submit"
          disabled={pending}
          className="w-full justify-center"
        >
          {pending ? "Verifying…" : "Verify email"}
        </Button>
        <button
          type="button"
          onClick={onResend}
          className="text-sm text-white/50 underline underline-offset-4 transition-colors hover:text-white"
        >
          Send a new code
        </button>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={onCreateAccount}>
      <FormError>{error}</FormError>
      <Field htmlFor="signup-name" label="Name">
        <Input
          id="signup-name"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field htmlFor="signup-email" label="Email">
        <Input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field
        htmlFor="signup-password"
        label="Password"
        hint="At least 8 characters."
      >
        <Input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
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
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
