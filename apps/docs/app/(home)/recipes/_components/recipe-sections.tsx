import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import type { RecipeLander } from "../_data/types";

type RecipeCardData = Pick<
  RecipeLander,
  "slug" | "title" | "cardDescription" | "category"
>;

/**
 * A recipe card linking into the cookbook — the recipe's section on its
 * category page (where the code and copy button live). Shared by the recipes
 * hub and the category pages.
 */
export function RecipeCard({
  recipe,
  index = 0,
}: {
  recipe: RecipeCardData;
  index?: number;
}): JSX.Element {
  return (
    <Reveal delay={(index % 3) * 0.08} className="h-full">
      <Link
        href={`/recipes/category/${recipe.category}#${recipe.slug}`}
        className="group block h-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
      >
        <Card className="flex h-full flex-col gap-3 group-hover:border-white/15">
          <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
            {recipe.title}
          </h3>
          <p className="text-base text-white/60 leading-6">
            {recipe.cardDescription}
          </p>
          <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm text-white/60 transition-colors group-hover:text-white">
            See the code
            <ArrowUpRight
              aria-hidden="true"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={1.5}
            />
          </span>
        </Card>
      </Link>
    </Reveal>
  );
}
