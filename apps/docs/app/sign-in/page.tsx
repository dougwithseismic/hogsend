import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in — Hogsend",
  robots: { index: false },
};

/** Only relative in-site paths are honoured as the post-sign-in return target. */
function safeNext(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const githubEnabled = Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
  );
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-3xl text-white tracking-[-0.02em]">
        Sign in to Hogsend
      </h1>
      <p className="mt-2 mb-8 text-sm text-white/55 leading-6">
        One account across hogsend.com and the courses. We'll email you a
        6-digit code — no password.
      </p>
      <SignInForm next={safeNext(next)} githubEnabled={githubEnabled} />
    </main>
  );
}
