import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * buildPlayPrompt — the play as a paste-into-your-agent prompt. Reads the
 * raw MDX (frontmatter stripped) so the prompt IS the play — when to run
 * it, why it works, the tool-agnostic steps, the Hogsend reference
 * implementation, and the success metric — wrapped in a short instruction.
 * Server-only (fs), assembled at build time by the play page.
 */
export async function buildPlayPrompt(opts: {
  slug: string;
  title: string;
  hook: string;
  url: string;
}): Promise<string> {
  const raw = await fs.readFile(
    path.join(process.cwd(), "content", "playbook", `${opts.slug}.mdx`),
    "utf8",
  );
  const body = raw
    .replace(/^---[\s\S]*?---\s*/, "") // frontmatter
    .replace(/\{\/\*[\s\S]*?\*\/\}\s*/g, "") // MDX comments
    .trim();

  return [
    "Implement this growth play in our codebase.",
    "",
    `# ${opts.title}`,
    "",
    opts.hook,
    "",
    body,
    "",
    "---",
    "Implementer notes:",
    `- The "Ship it with Hogsend" section is drop-in if we run Hogsend (https://hogsend.com/docs); otherwise treat it as the reference implementation and adapt the play's steps to our email/automation stack.`,
    `- Wire up the "How you'll know" metric before calling it shipped.`,
    "",
    `Source: ${opts.url}`,
    "",
  ].join("\n");
}
