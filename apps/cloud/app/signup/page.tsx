import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { sanitizeNext } from "@/src/lib/auth-guard";

export const metadata: Metadata = { title: "Create account" };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignupPage({ searchParams }: PageProps) {
  // Same `next` contract as /login: an invited visitor with no account signs up
  // here and lands back on the invitation.
  const raw = (await searchParams).next;
  const next = sanitizeNext(Array.isArray(raw) ? raw[0] : raw);
  const loginHref =
    next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  return (
    <AuthShell
      title="Create an account"
      description="Sign up, verify your email with a code, and you land in the control plane."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={loginHref}
            className="text-white underline underline-offset-4"
          >
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm next={next} />
    </AuthShell>
  );
}
