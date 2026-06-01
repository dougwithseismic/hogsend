import type { Database } from "@hogsend/db";
import { trackedLinks } from "@hogsend/db";

const HREF_RE = /href="(https?:\/\/[^"]+)"/gi;

const SKIP_PATTERNS = ["/v1/email/unsubscribe", "/v1/email/preferences"];

function shouldSkipUrl(url: string): boolean {
  return SKIP_PATTERNS.some((pattern) => url.includes(pattern));
}

export async function rewriteLinks(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
  db: Database;
}): Promise<string> {
  const { html, emailSendId, baseUrl, db } = opts;

  const uniqueUrls = new Set<string>();

  for (const match of html.matchAll(HREF_RE)) {
    const url = match[1];
    if (url && !shouldSkipUrl(url)) {
      uniqueUrls.add(url);
    }
  }

  if (uniqueUrls.size === 0) return html;

  const urlList = [...uniqueUrls];
  const rows = await db
    .insert(trackedLinks)
    .values(urlList.map((url) => ({ emailSendId, originalUrl: url })))
    .returning({ id: trackedLinks.id, originalUrl: trackedLinks.originalUrl });

  const urlToId = new Map<string, string>();
  for (const row of rows) {
    urlToId.set(row.originalUrl, row.id);
  }

  return html.replace(HREF_RE, (full, url: string) => {
    if (shouldSkipUrl(url)) return full;
    const linkId = urlToId.get(url);
    return linkId ? `href="${baseUrl}/v1/t/c/${linkId}"` : full;
  });
}

export function injectOpenPixel(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
}): string {
  const { html, emailSendId, baseUrl } = opts;
  const pixel = `<img src="${baseUrl}/v1/t/o/${emailSendId}" width="1" height="1" alt="" style="display:none" />`;

  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return html.slice(0, bodyCloseIdx) + pixel + html.slice(bodyCloseIdx);
  }

  return html + pixel;
}

export async function prepareTrackedHtml(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
  db: Database;
}): Promise<string> {
  let result = await rewriteLinks(opts);
  result = injectOpenPixel({
    html: result,
    emailSendId: opts.emailSendId,
    baseUrl: opts.baseUrl,
  });
  return result;
}
