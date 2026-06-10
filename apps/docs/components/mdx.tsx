import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DeployOnRailway } from "@/components/analytics/track";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    DeployOnRailway,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
