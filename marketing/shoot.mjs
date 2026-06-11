import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const OUT =
  "/Users/godzillaaa/Documents/WEB_PROJECTS/clients/growthhog/marketing/screenshots";
mkdirSync(`${OUT}/studio`, { recursive: true });
mkdirSync(`${OUT}/site`, { recursive: true });

const STUDIO = "http://localhost:3002/studio";
const VIEWPORT = { width: 1600, height: 1000 };

const browser = await chromium.launch();

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  return page;
}

async function shot(page, path, opts = {}) {
  await page.waitForTimeout(opts.settle ?? 1200);
  await page.screenshot({ path, fullPage: opts.fullPage ?? false });
  console.log("✓", path.split("/screenshots/")[1]);
}

// ── Studio: logged-out login screen ─────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await newPage(ctx);
  await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
  await shot(page, `${OUT}/studio/00-login.png`);
  await ctx.close();
}

// ── Studio: authenticated views ─────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await newPage(ctx);
  await page.goto(`${STUDIO}/`, { waitUntil: "networkidle" });
  await page
    .getByLabel(/email/i)
    .fill(process.env.STUDIO_EMAIL ?? "admin@example.com");
  await page.getByLabel(/password/i).fill(process.env.STUDIO_PASSWORD ?? "");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/studio/, { timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot(page, `${OUT}/studio/01-overview.png`);

  const views = [
    ["sends", "02-sends"],
    ["templates", "03-templates"],
    ["journeys", "04-journeys"],
    ["buckets", "05-buckets"],
    ["contacts", "06-contacts"],
    ["suppressions", "07-suppressions"],
    ["setup", "08-setup"],
    ["settings", "09-settings"],
    ["debug", "10-debug"],
  ];
  for (const [route, name] of views) {
    await page.goto(`${STUDIO}/${route}`, { waitUntil: "networkidle" });
    await shot(page, `${OUT}/studio/${name}.png`);
  }

  // Send detail drawer
  await page.goto(`${STUDIO}/sends`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const row = page.locator("tbody tr").first();
  if (await row.count()) {
    await row.click();
    await shot(page, `${OUT}/studio/11-send-drawer.png`, { settle: 1500 });
  }

  // Contact detail drawer
  await page.goto(`${STUDIO}/contacts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const crow = page.locator("tbody tr").first();
  if (await crow.count()) {
    await crow.click();
    await shot(page, `${OUT}/studio/12-contact-drawer.png`, { settle: 1500 });
  }
  await ctx.close();
}

// ── Marketing site (live) ───────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await newPage(ctx);
  await page.goto("https://hogsend.com", { waitUntil: "networkidle" });
  await shot(page, `${OUT}/site/00-hero.png`, { settle: 2500 });
  await shot(page, `${OUT}/site/01-landing-full.png`, {
    fullPage: true,
    settle: 500,
  });

  await page.goto("https://hogsend.com/docs", { waitUntil: "networkidle" });
  await shot(page, `${OUT}/site/02-docs.png`, { settle: 2000 });
  await ctx.close();
}

await browser.close();
console.log("DONE");
