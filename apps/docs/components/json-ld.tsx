/**
 * Renders a JSON-LD structured-data block. The payload is built on the server
 * from trusted data, so the only escaping needed is the `<` character (to keep
 * a stray `</script>` from breaking out of the tag). Server component — no
 * `"use client"`.
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-built, trusted JSON-LD with `<` escaped
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
