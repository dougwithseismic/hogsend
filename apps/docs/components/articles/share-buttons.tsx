"use client";

import { Check, Link as LinkIcon } from "lucide-react";
import { type JSX, useState } from "react";

/**
 * Per-platform share URL with UTM attribution: utm_source is the platform,
 * medium is social, campaign identifies the article by slug.
 */
function shareUrl(base: string, slug: string, source: string): string {
  const u = new URL(base);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", `article-${slug}`);
  return u.toString();
}

const BUTTON_CLASS =
  "inline-flex size-8 items-center justify-center rounded-[6px] border border-white/10 text-white/75 transition-colors hover:border-white/30 hover:text-white";

function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>X</title>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LinkedInMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>LinkedIn</title>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.119 20.452H3.555V9h3.564v11.452z" />
    </svg>
  );
}

function RedditMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>Reddit</title>
      <path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" />
    </svg>
  );
}

function HNMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <title>Hacker News</title>
      <path d="M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z" />
    </svg>
  );
}

type ShareButtonsProps = {
  /** Absolute canonical article URL (no params). */
  url: string;
  slug: string;
  title: string;
  className?: string;
};

/** Icon-square share row (X, LinkedIn, Reddit, HN, copy) with UTM tagging. */
export function ShareButtons({
  url,
  slug,
  title,
  className,
}: ShareButtonsProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const targets = [
    {
      label: "Share on X",
      href: `https://x.com/intent/post?text=${encodeURIComponent(title)}&url=${encodeURIComponent(shareUrl(url, slug, "x"))}`,
      icon: <XMark className="size-3.5" />,
    },
    {
      label: "Share on LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl(url, slug, "linkedin"))}`,
      icon: <LinkedInMark className="size-4" />,
    },
    {
      label: "Share on Reddit",
      href: `https://www.reddit.com/submit?url=${encodeURIComponent(shareUrl(url, slug, "reddit"))}&title=${encodeURIComponent(title)}`,
      icon: <RedditMark className="size-4" />,
    },
    {
      label: "Share on Hacker News",
      href: `https://news.ycombinator.com/submitlink?u=${encodeURIComponent(shareUrl(url, slug, "hackernews"))}&t=${encodeURIComponent(title)}`,
      icon: <HNMark className="size-4" />,
    },
  ];

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl(url, slug, "copy-link"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={className}>
      <p className="eyebrow mb-3 text-white/50">Share</p>
      <div className="flex flex-wrap gap-2">
        {targets.map((t) => (
          <a
            key={t.label}
            href={t.href}
            target="_blank"
            rel="noreferrer"
            aria-label={t.label}
            className={BUTTON_CLASS}
          >
            {t.icon}
          </a>
        ))}
        <button
          type="button"
          onClick={copyLink}
          aria-label="Copy link"
          className={BUTTON_CLASS}
        >
          {copied ? (
            <Check className="size-4 text-accent" />
          ) : (
            <LinkIcon className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
