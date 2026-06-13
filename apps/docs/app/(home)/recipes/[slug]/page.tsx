import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import {
  ClosingCta,
  CodeWalkthrough,
  PointsGrid,
  ProblemStatement,
  UseCaseFaq,
} from "../../use-cases/_components/use-case-sections";
import {
  RecipeHero,
  RecipePager,
  RelatedRecipes,
} from "../_components/recipe-sections";
import {
  getCategoryNeighbours,
  getRecipeLander,
  RECIPE_LANDERS,
} from "../_data";
import { RECIPE_CATEGORIES } from "../_data/types";

export function generateStaticParams(): Array<{ slug: string }> {
  return RECIPE_LANDERS.map((recipe) => ({ slug: recipe.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const recipe = getRecipeLander(slug);
  if (!recipe) notFound();

  return {
    title: recipe.title,
    description: recipe.metaDescription,
  };
}

export default async function RecipeLanderPage(props: {
  params: Promise<{ slug: string }>;
}): Promise<JSX.Element> {
  const { slug } = await props.params;
  const recipe = getRecipeLander(slug);
  if (!recipe) notFound();

  const docsHref = `/docs/recipes/${recipe.slug}`;
  const related = recipe.related
    .map((relatedSlug) => getRecipeLander(relatedSlug))
    .filter((sibling) => sibling !== undefined);
  const neighbours = getCategoryNeighbours(slug);
  const category = RECIPE_CATEGORIES[recipe.category];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: recipe.faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static catalog data defined in _data/ — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <RecipeHero
        eyebrow={recipe.eyebrow}
        title={recipe.title}
        subhead={recipe.subhead}
        docsHref={docsHref}
      />

      <ProblemStatement label={recipe.problem.label}>
        {recipe.problem.statement}
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow={recipe.walkthrough.eyebrow}
        title={recipe.walkthrough.title}
        subtitle={recipe.walkthrough.subtitle}
        blocks={recipe.code}
        note={recipe.walkthrough.note}
      />

      <PointsGrid
        eyebrow={category.title}
        title="Why it holds up"
        points={recipe.points}
      />

      <UseCaseFaq items={recipe.faq} links={recipe.links} />

      {neighbours && (neighbours.prev || neighbours.next) ? (
        <RecipePager
          categoryTitle={category.title}
          categoryHref={`/recipes/category/${recipe.category}`}
          prev={
            neighbours.prev
              ? { slug: neighbours.prev.slug, title: neighbours.prev.title }
              : undefined
          }
          next={
            neighbours.next
              ? { slug: neighbours.next.slug, title: neighbours.next.title }
              : undefined
          }
        />
      ) : null}

      {related.length > 0 ? <RelatedRecipes recipes={related} /> : null}

      <ClosingCta
        title="Ship it from a scaffold"
        subtitle="Every recipe drops into a create-hogsend app as one TypeScript file — the docs page walks the full wiring."
      />
    </main>
  );
}
