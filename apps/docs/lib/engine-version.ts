import { ENGINE_VERSION } from "./site";

/**
 * The latest published `@hogsend/engine` version, read live from the npm
 * registry so the homepage always shows what's actually shipping — no manual
 * bump. Cached with hourly revalidation (ISR); falls back to the pinned
 * ENGINE_VERSION when the registry is unreachable at render time.
 */
export async function getEngineVersion(): Promise<string> {
  try {
    const res = await fetch(
      "https://registry.npmjs.org/@hogsend/engine/latest",
      { next: { revalidate: 3600 } },
    );
    if (!res.ok) return ENGINE_VERSION;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : ENGINE_VERSION;
  } catch {
    return ENGINE_VERSION;
  }
}
