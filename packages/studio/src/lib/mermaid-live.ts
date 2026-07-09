/**
 * Build a mermaid.live editor deep link for a diagram, browser-side.
 *
 * The editor accepts two hash encodings of its JSON state: `#pako:` (zlib) and
 * `#base64:` (plain base64 of the JSON). The CLI uses `pako` via Node's zlib;
 * in the browser we use the zero-dependency `base64` form — supported by the
 * same editor deserializer — so Studio needs no compression library.
 */
export function mermaidLiveUrl(code: string): string {
  const state = JSON.stringify({
    code,
    mermaid: JSON.stringify({ theme: "dark" }),
    autoSync: true,
    updateDiagram: true,
  });
  // UTF-8 safe base64 (btoa alone mishandles multibyte chars in labels).
  const bytes = new TextEncoder().encode(state);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return `https://mermaid.live/edit#base64:${b64}`;
}
