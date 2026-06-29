import Link from "next/link";
import type { ReactNode } from "react";
import { PageFrame } from "@/components/ds/page-frame";
import { GITHUB_URL, HOGSEND_URL } from "@/lib/site";

/** Public catalog shell: brand nav + footer + the crimzon page frame. */
export default function CatalogLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageFrame />
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="border-hairline-faint border-b">
          <div className="container-page flex h-16 items-center justify-between">
            <Link
              href="/"
              className="font-display font-medium text-white tracking-[-0.02em]"
            >
              Hogsend <span className="text-white/40">Courses</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm text-white/60">
              <Link href="/" className="transition-colors hover:text-white">
                Courses
              </Link>
              <a
                href={HOGSEND_URL}
                className="transition-colors hover:text-white"
              >
                Hogsend ↗
              </a>
              <a
                href={GITHUB_URL}
                className="transition-colors hover:text-white"
              >
                GitHub ↗
              </a>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-hairline-faint border-t">
          <div className="container-page flex h-16 items-center justify-between text-sm text-white/40">
            <span>© Hogsend</span>
            <a
              href={HOGSEND_URL}
              className="transition-colors hover:text-white"
            >
              hogsend.com ↗
            </a>
          </div>
        </footer>
      </div>
    </>
  );
}
