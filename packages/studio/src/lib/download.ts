/**
 * Trigger a browser download of a data URL (or object URL) by synthesizing a
 * transient `<a download>` and clicking it. Object URLs are revoked afterwards;
 * plain `data:` URLs need no revocation (there is nothing to release).
 */
export function downloadDataUrl(name: string, url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (url.startsWith("blob:")) {
    // Give the download a tick to start before releasing the object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}
