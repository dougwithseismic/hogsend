import Link from "next/link";
import { Wordmark } from "@/components/ds/decor";
import { Reveal } from "@/components/ds/reveal";
import { Logo } from "@/components/landing/logo";
import { cn } from "@/lib/cn";

const REPO_URL = "https://github.com/dougwithseismic/hogsend";
const NPM_URL = "https://www.npmjs.com/package/@hogsend/engine";

type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
};

type FooterColumn = {
  heading: string;
  links: FooterLink[];
};

const COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "Compare", href: "/docs/compare" },
      { label: "Studio", href: "/docs/operating/studio" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "API Reference", href: "/docs/api" },
      { label: "Guides", href: "/docs/guides/journeys" },
      { label: "CLI", href: "/docs/cli" },
      { label: "About", href: "/docs/about" },
    ],
  },
  {
    heading: "Community",
    links: [
      { label: "GitHub", href: REPO_URL, external: true },
      { label: "npm", href: NPM_URL, external: true },
    ],
  },
];

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function FooterLinkItem({ link }: { link: FooterLink }) {
  const className = "text-sm text-white/55 transition-colors hover:text-white";

  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel="noreferrer"
        className={className}
      >
        {link.label}
      </a>
    );
  }

  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn("relative overflow-hidden bg-ink text-white", className)}
    >
      <div className="container-page relative z-10 pt-20 pb-10 md:pt-28">
        <Reveal>
          <div className="grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)] md:gap-8">
            {/* Brand + tagline */}
            <div className="max-w-sm">
              <Logo />
              <p className="mt-5 text-sm leading-relaxed text-white/55">
                Code-first lifecycle email for teams on PostHog + Resend.
                Self-hosted and yours to run.
              </p>
            </div>

            {/* Link columns */}
            {COLUMNS.map((column) => (
              <nav key={column.heading} aria-label={column.heading}>
                <h2 className="eyebrow text-white/40">{column.heading}</h2>
                <ul className="mt-5 flex flex-col gap-3">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <FooterLinkItem link={link} />
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </Reveal>

        {/* Bottom bar */}
        <div className="mt-16 flex flex-col items-start gap-4 border-t border-white/[0.08] pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-white/40">© 2026 Hogsend</p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Hogsend on GitHub"
            className="inline-flex size-9 items-center justify-center rounded-md border border-white/10 text-white/55 transition-colors hover:border-white/20 hover:text-white"
          >
            <GitHubMark className="size-4" />
          </a>
        </div>
      </div>

      {/* Giant faint watermark spanning the full width, anchored to the bottom */}
      <Wordmark
        text="HOGSEND"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 translate-y-[18%] text-center"
      />
    </footer>
  );
}
