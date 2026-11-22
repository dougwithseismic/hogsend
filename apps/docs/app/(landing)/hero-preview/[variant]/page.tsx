import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { HERO_VARIANTS, type HeroVariant, HomeView } from "../../page";

/**
 * Hero previews. `/?hero=<variant>` is rewritten here (next.config.mjs,
 * beforeFiles) so the homepage itself can stay static: the same page with one
 * hero variant forced and the field clock/scrubber controls shown. Not for
 * search engines — the canonical page is `/`.
 */
export const metadata: Metadata = {
  title: { absolute: "Hogsend — hero preview" },
  alternates: { canonical: "/" },
  robots: { index: false, follow: false },
};

export const dynamicParams = false;
export const revalidate = 3600;

export function generateStaticParams(): { variant: HeroVariant }[] {
  return HERO_VARIANTS.map((variant) => ({ variant }));
}

function isHeroVariant(value: string): value is HeroVariant {
  return (HERO_VARIANTS as readonly string[]).includes(value);
}

export default async function HeroPreviewPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}): Promise<JSX.Element> {
  const { variant } = await params;
  if (!isHeroVariant(variant)) notFound();
  return <HomeView hero={variant} />;
}
