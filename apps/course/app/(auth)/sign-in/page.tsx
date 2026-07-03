import type { Metadata } from "next";
import Link from "next/link";
import { SignInForm } from "@/components/auth/sign-in-form";
import { PageFrame } from "@/components/ds/page-frame";
import { safeNext } from "@/lib/safe-next";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default async function SignInPage(props: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next) ?? "/";
  const githubEnabled = Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
  );

  return (
    <>
      <PageFrame />
      <main className="relative z-10 flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <Link href="/" className="font-display text-white tracking-[-0.02em]">
            Hogsend <span className="text-white/40">Courses</span>
          </Link>
          <h1 className="mt-8 font-display text-2xl tracking-[-0.02em]">
            Create your free account
          </h1>
          <p className="mt-2 text-sm text-white/60 leading-6">
            Sign in to unlock every lesson. No password — we email you a 6-digit
            code{githubEnabled ? ", or use GitHub" : ""}.
          </p>
          <div className="mt-8">
            <SignInForm next={next} githubEnabled={githubEnabled} />
          </div>
        </div>
      </main>
    </>
  );
}
