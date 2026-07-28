import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <AuthShell
      title="Create an account"
      description="Sign up, verify your email with a code, and you land in the control plane."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-white underline underline-offset-4"
          >
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
