import type { Metadata } from "next";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { getEngineVersion } from "@/lib/engine-version";
import { MINTED_FILES } from "./minted-files";
import { WiredHero } from "./wired-hero";

/**
 * Spike — "wired stage" homepage hero.
 * The CLI replay plus the journey it just minted as the hero object, over the
 * day-field vista. Not linked from nav.
 *
 * Shiki runs here rather than in the panel: `CodeHighlight` is an async RSC and
 * the panel is a client component (it holds the active-tab state), so every
 * scenario is highlighted on the server up front and handed down by id.
 */
export const metadata: Metadata = {
  title: "Spike — wired stage hero",
  robots: { index: false, follow: false },
};

export default async function SpikeWiredHeroPage() {
  const engineVersion = await getEngineVersion();

  // Shiki is an async RSC and the window stage is a client component, so
  // every written file is highlighted here and handed down keyed by path.
  const highlighted = Object.fromEntries(
    Object.values(MINTED_FILES)
      .filter((file) => file.kind === "code")
      .map((file) => [
        file.path,
        <CodeHighlight key={file.path} code={file.source} lang="ts" />,
      ]),
  );

  return <WiredHero engineVersion={engineVersion} highlighted={highlighted} />;
}
