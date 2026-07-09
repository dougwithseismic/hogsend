import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DeployOnRailway } from "@/components/analytics/track";
import { MermaidPre } from "@/components/mermaid";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Render ```mermaid fences via the crimson-themed <Mermaid> component.
    pre: MermaidPre,
    DeployOnRailway,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
