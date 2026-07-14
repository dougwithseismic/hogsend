/**
 * The ONE loopback detector for the CLI (connect flows, admin-key mint).
 * Kept in LOCKSTEP with the engine's `isLoopbackPublicUrl`
 * (packages/engine/src/routes/admin/analytics.ts) — that one lives behind the
 * engine ROOT barrel (import-time env validation), so the CLI carries its own
 * copy; keep the two identical.
 */
export function isLoopbackUrl(publicUrl: string): boolean {
  try {
    const host = new URL(publicUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
