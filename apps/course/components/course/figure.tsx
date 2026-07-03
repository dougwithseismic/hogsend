import type { JSX } from "react";

/**
 * A captioned image for lesson bodies. Renders a native <img> (not next/image)
 * so authored MDX can drop in a screenshot with a plain `/images/...` path — no
 * width/height/remote-pattern bookkeeping — and get a framed figure with an
 * optional caption and source attribution underneath. `not-prose` so the
 * surrounding typography styles don't fight the frame.
 *
 * `src` is a public path (e.g. `/images/foo.png`). `caption` is the line under
 * the image; `sourceHref`/`sourceLabel` render a small attribution link when the
 * image comes from somewhere worth crediting.
 */
export function Figure({
  src,
  alt,
  caption,
  sourceHref,
  sourceLabel,
}: {
  src: string;
  alt: string;
  caption?: string;
  sourceHref?: string;
  sourceLabel?: string;
}): JSX.Element {
  return (
    <figure className="not-prose my-8">
      <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-white/[0.02]">
        {/* biome-ignore lint/performance/noImgElement: authored screenshot; native img avoids next/image width/height + remote-pattern config */}
        <img
          src={src}
          alt={alt}
          className="block h-auto w-full"
          loading="lazy"
        />
      </div>
      {caption || sourceHref ? (
        <figcaption className="mt-3 text-center text-sm text-white/50 leading-relaxed">
          {caption}
          {sourceHref ? (
            <>
              {caption ? " " : null}
              <a
                href={sourceHref}
                target="_blank"
                rel="noreferrer"
                className="text-white/60 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/80"
              >
                {sourceLabel ?? "Source"} ↗
              </a>
            </>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
