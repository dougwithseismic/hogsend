import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrandTemplateCanvas } from "@/components/brand/brand-template-canvas";
import { BrandTemplateContentLayer } from "@/components/brand/brand-template-content";
import {
  resolveBrandCarouselCard,
  resolveBrandTextExample,
} from "@/lib/brand-template-content";
import {
  COLORWAY_PRESETS,
  isBrandTemplatePaletteKey,
  isBrandTemplatePresetKey,
  isBrandTemplateTreatment,
} from "@/lib/brand-template-presets";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function BrandTemplatePreview({
  params,
  searchParams,
}: {
  params: Promise<{ preset: string }>;
  searchParams: Promise<{
    treatment?: string;
    palette?: string;
    example?: string;
    platform?: string;
    variant?: string;
    card?: string;
  }>;
}) {
  const { preset } = await params;
  const query = await searchParams;
  if (!isBrandTemplatePresetKey(preset)) {
    notFound();
  }
  const campaignValues = [query.platform, query.variant, query.card];
  const hasCampaignQuery = campaignValues.some(Boolean);
  const hasContentQuery = Boolean(query.example) || hasCampaignQuery;
  if (hasContentQuery) {
    if (query.treatment || query.palette) notFound();

    const contentJob = query.example
      ? hasCampaignQuery
        ? undefined
        : resolveBrandTextExample(query.example)
      : campaignValues.every(Boolean)
        ? resolveBrandCarouselCard(
            query.platform ?? "",
            query.variant ?? "",
            Number(query.card),
          )
        : undefined;
    if (!contentJob || contentJob.preset !== preset) notFound();

    return (
      <main style={{ margin: 0, width: "fit-content", lineHeight: 0 }}>
        <style>{`
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: transparent !important;
            overflow: hidden !important;
          }
        `}</style>
        <BrandTemplateCanvas
          preset={preset}
          treatment="clean"
          palette={contentJob.palette}
        >
          <BrandTemplateContentLayer
            preset={preset}
            palette={contentJob.palette}
            content={contentJob.content}
          />
        </BrandTemplateCanvas>
      </main>
    );
  }

  const treatment = query.treatment ?? "clean";
  const palette = query.palette ?? "default";
  if (
    !isBrandTemplateTreatment(treatment) ||
    !isBrandTemplatePaletteKey(palette)
  ) {
    notFound();
  }
  const validColorway =
    treatment === "colorway" &&
    palette !== "default" &&
    COLORWAY_PRESETS.includes(preset as (typeof COLORWAY_PRESETS)[number]);
  const validCore = treatment !== "colorway" && palette === "default";
  if (!validColorway && !validCore) {
    notFound();
  }

  return (
    <main style={{ margin: 0, width: "fit-content", lineHeight: 0 }}>
      <style>{`
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: transparent !important;
          overflow: hidden !important;
        }
      `}</style>
      <BrandTemplateCanvas
        preset={preset}
        treatment={treatment}
        palette={palette}
      />
    </main>
  );
}
