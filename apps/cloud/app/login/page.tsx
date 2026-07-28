import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { sanitizeNext } from "@/src/lib/auth-guard";

export const metadata: Metadata = { title: "Sign in" };

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: PageProps) {
  // An invitation link sends a signed-out visitor here and expects them back:
  // `next` is where to return to, sanitized to a same-origin path.
  const raw = (await searchParams).next;
  const next = sanitizeNext(Array.isArray(raw) ? raw[0] : raw);
  const signupHref =
    next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`;

  return (
    <AuthShell
      title="Sign in"
      description="Access the control plane for your managed Hogsend instances."
      footer={
        <>
          No account yet?{" "}
          <Link
            href={signupHref}
            className="text-white underline underline-offset-4"
          >
            Create one
          </Link>
        </>
      }
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
