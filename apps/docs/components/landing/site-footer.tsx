import Link from "next/link";
import { Logo } from "@/components/landing/logo";
import { cn } from "@/lib/cn";
import { CONTACT_EMAIL, ENGINE_VERSION, GITHUB_URL, NPM_URL } from "@/lib/site";

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
      { label: "Pricing", href: "/pricing" },
      { label: "Templates", href: "/emails" },
      { label: "Integrations", href: "/integrations" },
      { label: "Recipes", href: "/recipes" },
      { label: "Studio", href: "/docs/operating/studio" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
  {
    heading: "Use cases",
    links: [
      { label: "Onboarding", href: "/use-cases/onboarding" },
      { label: "Trial conversion", href: "/use-cases/trial-conversion" },
      { label: "Win-back", href: "/use-cases/winback" },
      {
        label: "Transactional email",
        href: "/docs/recipes/transactional-emails",
      },
    ],
  },
  {
    heading: "Compare",
    links: [
      {
        label: "vs PostHog Workflows",
        href: "/docs/compare/posthog-workflows",
      },
      { label: "vs Loops", href: "/docs/compare/loops" },
      { label: "vs Customer.io", href: "/docs/compare/customer-io" },
      { label: "vs Klaviyo", href: "/docs/compare/klaviyo" },
      { label: "Feature matrix", href: "/docs/compare/feature-matrix" },
      { label: "Migration guide", href: "/docs/compare/migration" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Data API", href: "/docs/data-api" },
      { label: "CLI", href: "/docs/cli" },
      { label: "API reference", href: "/docs/api" },
      { label: "llms.txt", href: "/llms.txt" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "npm", href: NPM_URL, external: true },
      { label: "Contact", href: `mailto:${CONTACT_EMAIL}` },
      { label: "License", href: "/pricing#license" },
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
  const className =
    "text-base tracking-[-0.02em] text-white/60 transition-colors hover:text-white";

  // External URLs, mailto: and static files (/llms.txt) need a plain anchor.
  const isPlainAnchor =
    link.external ||
    link.href.startsWith("mailto:") ||
    link.href === "/llms.txt";

  if (isPlainAnchor) {
    return (
      <a
        href={link.href}
        className={className}
        {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
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

/**
 * Slim crimzon footer: top hairline, brand block + five link columns over the
 * dark canvas, then a full-width hairline bottom bar. No giant wordmark.
 */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "border-t border-hairline-faint bg-ink text-white",
        className,
      )}
    >
      <div className="container-page py-20">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-[1.3fr_repeat(5,1fr)]">
          {/* Brand + tagline */}
          <div className="col-span-2 max-w-sm sm:col-span-3 lg:col-span-1 lg:pr-6">
            <Logo />
            <p className="mt-5 text-base leading-6 tracking-[-0.02em] text-white/60">
              Code-first lifecycle email for teams on PostHog. Your provider,
              your data, your repo. Free to self-host under ELv2.
            </p>
          </div>

          {/* Link columns */}
          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-base font-medium tracking-[-0.02em] text-white">
                {column.heading}
              </h2>
              <ul className="mt-5 flex flex-col gap-4">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterLinkItem link={link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      {/* Bottom bar — full-width hairline, single slim line. */}
      <div className="border-t border-hairline-faint">
        <div className="container-page flex flex-col items-start gap-3 py-6 text-sm text-white/50 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Hogsend</p>
          <p className="eyebrow text-white/50">Source-available · ELv2</p>
          <div className="flex items-center gap-5">
            <Link
              href="/changelog"
              className="transition-colors hover:text-white"
            >
              v{ENGINE_VERSION} — latest release →
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Hogsend on GitHub"
              className="text-white/50 transition-colors hover:text-white"
            >
              <GitHubMark className="size-4" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
