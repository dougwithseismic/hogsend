export function htmlPage(opts: { title: string; body: string }): string {
  const { title, body } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #555; line-height: 1.6; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pref-section { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin: 28px 0 4px; }
    .pref-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .pref-label { font-weight: 500; }
    .pref-status { font-size: 0.875rem; }
    .subscribed { color: #16a34a; }
    .unsubscribed { color: #dc2626; }
    .global-row { margin-top: 24px; padding-top: 16px; border-top: 2px solid #e5e7eb; }
  </style>
</head>
<body>${body}</body>
</html>`;
}
