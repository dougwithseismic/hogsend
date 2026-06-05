import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { getMDXComponents } from "@/components/mdx";
import { SITE_URL } from "@/lib/site";
import { source } from "@/lib/source";
import { breadcrumb, techArticle } from "@/lib/structured-data";

/** Turn a URL slug segment (`getting-started`) into a label (`Getting Started`). */
function segmentLabel(segment: string): string {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Build the Home → Docs → … → current breadcrumb trail for a docs page. */
function buildBreadcrumb(slug: string[] | undefined, title: string) {
  const crumbs = [
    { name: "Home", url: SITE_URL },
    { name: "Docs", url: `${SITE_URL}/docs` },
  ];

  const segments = slug ?? [];
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    crumbs.push({
      name: isLast ? title : segmentLabel(segment),
      url: `${SITE_URL}/docs/${segments.slice(0, index + 1).join("/")}`,
    });
  });

  return crumbs;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const url = `${SITE_URL}${page.url}`;

  return (
    <>
      <JsonLd
        data={techArticle({
          title: page.data.title,
          description: page.data.description ?? "",
          url,
        })}
      />
      <JsonLd
        data={breadcrumb(buildBreadcrumb(params.slug, page.data.title))}
      />
      <DocsPage toc={page.data.toc} full={page.data.full}>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
      </DocsPage>
    </>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const { title, description } = page.data;

  return {
    title,
    description,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      type: "article",
      title,
      description,
      url: page.url,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}
