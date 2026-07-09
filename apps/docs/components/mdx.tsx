import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DeployOnRailway } from "@/components/analytics/track";
import { StudioDemoCallout } from "@/components/studio-demo-callout";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    DeployOnRailway,
    StudioDemoCallout,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
