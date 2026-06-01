import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1">
      <h1 className="text-2xl font-bold mb-4">Hogsend Documentation</h1>
      <p className="text-fd-muted-foreground mb-6">
        Code-first lifecycle orchestration for teams on PostHog + Resend.
      </p>
      <p>
        <Link href="/docs" className="font-medium underline">
          Get Started →
        </Link>
      </p>
    </div>
  );
}
