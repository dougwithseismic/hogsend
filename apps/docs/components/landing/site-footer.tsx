import Link from "next/link";
import { Wordmark } from "@/components/ds/decor";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

const REPO_URL = "https://github.com/dougwithseismic/hogsend";
const NPM_URL = "https://www.npmjs.com/package/@hogsend/engine";
const X_URL = "https://x.com/hogsend";

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

const META_LINKS: FooterLink[] = [
  { label: "Privacy", href: "/docs/legal/privacy" },
  { label: "Terms", href: "/docs/legal/terms" },
  { label: "License", href: REPO_URL, external: true },
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

function NpmMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M0 2.667h16v10.666H8v1.334H4.667v-1.334H0V2.667Zm1.333 9.333h2V5.333h1.334V12h1.333V4H1.333v8Zm6-8v9.333h2.667V12h2.667V4H7.333Zm4 1.333V12h-1.333V5.333H11.333Z" />
    </svg>
  );
}

function XMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12.6 1.5h2.18l-4.77 5.45L15.62 14.5h-4.4L7.78 9.99 3.84 14.5H1.66l5.1-5.83L1.13 1.5h4.52l3.11 4.11L12.6 1.5Zm-.77 11.7h1.21L4.43 2.73H3.14l8.69 10.47Z" />
    </svg>
  );
}

type SocialLink = {
  label: string;
  href: string;
  Icon: ({ className }: { className?: string }) => React.JSX.Element;
};

const SOCIALS: SocialLink[] = [
  { label: "Hogsend on GitHub", href: REPO_URL, Icon: GitHubMark },
  { label: "Hogsend on npm", href: NPM_URL, Icon: NpmMark },
  { label: "Hogsend on X", href: X_URL, Icon: XMark },
];

/** Ink-toned brand lockup for the cream footer: bar mark + "Hogsend". */
function BrandLockup() {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <span aria-hidden className="flex shrink-0 items-end gap-[2px]">
        <span className="block h-3 w-[3px] rounded-full bg-glow" />
        <span className="block h-5 w-[3px] rounded-full bg-ink" />
        <span className="block h-2.5 w-[3px] rounded-full bg-fathom" />
      </span>
      <span className="font-display text-xl leading-none tracking-tight">
        Hogsend
      </span>
    </span>
  );
}

function FooterLinkItem({
  link,
  className,
}: {
  link: FooterLink;
  className?: string;
}) {
  const cls = cn(
    "text-sm text-ink/60 transition-colors hover:text-ink",
    className,
  );

  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noreferrer" className={cls}>
        {link.label}
      </a>
    );
  }

  return (
    <Link href={link.href} className={cls}>
      {link.label}
    </Link>
  );
}

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "relative overflow-hidden bg-transparent text-ink",
        className,
      )}
    >
      <div className="container-page relative z-10 pt-20 pb-10 md:pt-28">
        <Reveal>
          <div className="grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)] md:gap-8">
            {/* Brand + tagline */}
            <div className="max-w-sm">
              <BrandLockup />
              <p className="mt-5 text-sm leading-relaxed text-ink/60">
                Code-first lifecycle email for teams on PostHog + Resend.
                Self-hosted and yours to run.
              </p>
            </div>

            {/* Link columns — serif headings */}
            {COLUMNS.map((column) => (
              <nav key={column.heading} aria-label={column.heading}>
                <h2 className="font-display text-lg leading-none tracking-tight text-ink">
                  {column.heading}
                </h2>
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

        {/* Giant ink wordmark — Hogsend's analog to Wispr's huge "Flow". */}
        <Wordmark
          text="Hogsend"
          className="mt-20 w-full justify-start text-ink md:mt-28"
        />

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-start gap-5 border-t border-ink/10 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <p className="text-sm text-ink/50">© Hogsend 2026</p>
            {META_LINKS.map((link) => (
              <FooterLinkItem key={link.label} link={link} />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {SOCIALS.map(({ label, href, Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={label}
                className="inline-flex size-9 items-center justify-center rounded-[12px] border-2 border-ink/15 text-ink/60 transition-colors hover:border-ink hover:text-ink"
              >
                <Icon className="size-4" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
