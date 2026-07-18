import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const PRESETS = Object.freeze({
  og: { width: 1200, height: 630, transparent: false },
  golden: { width: 1200, height: 742, transparent: false },
  "social-9x6": { width: 1080, height: 720, transparent: false },
  "social-square": { width: 1080, height: 1080, transparent: false },
  "social-portrait": { width: 1080, height: 1350, transparent: false },
  story: { width: 1080, height: 1920, transparent: false },
  "youtube-thumbnail": { width: 1280, height: 720, transparent: false },
  "youtube-banner": { width: 2560, height: 1440, transparent: false },
  "linkedin-post": { width: 1200, height: 627, transparent: false },
  "linkedin-profile-banner": {
    width: 1584,
    height: 396,
    transparent: false,
  },
  "linkedin-company-banner": {
    width: 4200,
    height: 700,
    transparent: false,
  },
  "x-post": { width: 1600, height: 900, transparent: false },
  "x-header": { width: 1500, height: 500, transparent: false },
  "stream-overlay": { width: 1920, height: 1080, transparent: true },
  "stream-screen": { width: 1920, height: 1080, transparent: false },
});

const PALETTES = Object.freeze(["default", "ember", "violet", "cyan", "acid"]);
const TREATMENTS = Object.freeze(["clean", "signed", "colorway"]);
const COLORWAY_PALETTES = Object.freeze(["ember", "violet", "cyan", "acid"]);
const COLORWAY_PRESETS = Object.freeze([
  "og",
  "social-square",
  "social-portrait",
  "youtube-thumbnail",
  "stream-screen",
]);
const EXAMPLES = Object.freeze([
  ["og-product-logic", "og", "default"],
  ["youtube-lifecycle-automation", "youtube-thumbnail", "ember"],
  ["linkedin-measure-keep-grow", "linkedin-post", "violet"],
  ["square-typed-tested-shipped", "social-square", "cyan"],
  ["portrait-signup-to-retention", "social-portrait", "acid"],
  ["stream-building-live", "stream-screen", "default"],
]);
const CAMPAIGNS = Object.freeze({
  meta: Object.freeze({
    "leaking-bucket": "ember",
    "after-signup": "violet",
    "launch-spike": "cyan",
  }),
  reddit: Object.freeze({
    "one-person-silo": "ember",
    "silent-drift": "violet",
    "clock-speed": "acid",
  }),
  linkedin: Object.freeze({
    "shipping-not-launching": "ember",
    "owner-bottleneck": "violet",
    "launch-pipeline": "cyan",
  }),
});
const CAMPAIGN_ROLES = Object.freeze([
  "problem",
  "action",
  "hogsend",
  "get-started",
]);
const JOB_KINDS = Object.freeze(["template", "example", "campaign"]);

export const INTERCEPTED_ROUTES = Object.freeze([
  "**/api/auth/get-session",
  "**/api/posthog-config",
]);

const scriptPath = fileURLToPath(import.meta.url);
const docsRoot = join(dirname(scriptPath), "..");
const outputRoot =
  process.env.BRAND_TEMPLATE_OUT_ROOT ??
  join(docsRoot, "../..", "marketing/out/templates");
const defaultDesktopRoot = join(
  homedir(),
  "Desktop",
  "Hogsend Brand Templates",
);

export function jobKey(job) {
  if (job.kind === "example") return `example:${job.example}`;
  if (job.kind === "campaign") {
    return `campaign:${job.platform}:${job.variant}:${job.card}`;
  }
  return `template:${job.preset}:${job.treatment}:${job.palette}`;
}

export function createRenderJobs() {
  const jobs = [];
  for (const [preset, dimensions] of Object.entries(PRESETS)) {
    jobs.push({
      kind: "template",
      preset,
      treatment: "clean",
      palette: "default",
      ...dimensions,
    });
    jobs.push({
      kind: "template",
      preset,
      treatment: "signed",
      palette: "default",
      ...dimensions,
    });
  }
  for (const preset of COLORWAY_PRESETS) {
    for (const palette of COLORWAY_PALETTES) {
      jobs.push({
        kind: "template",
        preset,
        treatment: "colorway",
        palette,
        ...PRESETS[preset],
      });
    }
  }
  for (const [example, preset, palette] of EXAMPLES) {
    jobs.push({
      kind: "example",
      example,
      preset,
      treatment: "clean",
      palette,
      ...PRESETS[preset],
    });
  }
  for (const [platform, campaigns] of Object.entries(CAMPAIGNS)) {
    for (const [variant, palette] of Object.entries(campaigns)) {
      for (let index = 0; index < CAMPAIGN_ROLES.length; index += 1) {
        jobs.push({
          kind: "campaign",
          platform,
          variant,
          card: index + 1,
          role: CAMPAIGN_ROLES[index],
          preset: "social-square",
          treatment: "clean",
          palette,
          ...PRESETS["social-square"],
        });
      }
    }
  }
  return jobs;
}

export function outputRelativePath(job) {
  if (job.kind === "example") return `examples/${job.example}.png`;
  if (job.kind === "campaign") {
    return `campaigns/${job.platform}/${job.variant}/${String(job.card).padStart(2, "0")}-${job.role}.png`;
  }
  const { preset, treatment, palette } = job;
  if (treatment === "colorway") {
    return `colorways/${palette}/${preset}--${palette}.png`;
  }
  if (preset.startsWith("stream-")) {
    return `stream/${preset}--${treatment}.png`;
  }
  return `${treatment}/${preset}--${treatment}.png`;
}

function requireFlagValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseRenderArguments(rawArgs) {
  const args = rawArgs.filter((value) => value !== "--");
  const filters = {};
  let desktop = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--desktop") {
      desktop = true;
      continue;
    }
    if (argument === "--kind") {
      filters.kind = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--example") {
      filters.example = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--platform") {
      filters.platform = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--variant") {
      filters.variant = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--card") {
      filters.card = Number(requireFlagValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--preset") {
      filters.preset = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--treatment") {
      filters.treatment = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--palette") {
      filters.palette = requireFlagValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`Unknown renderer argument: ${argument}`);
  }

  if (filters.preset && !Object.hasOwn(PRESETS, filters.preset)) {
    throw new Error(`Unknown brand template preset: ${filters.preset}`);
  }
  if (filters.treatment && !TREATMENTS.includes(filters.treatment)) {
    throw new Error(`Unknown brand template treatment: ${filters.treatment}`);
  }
  if (filters.palette && !PALETTES.includes(filters.palette)) {
    throw new Error(`Unknown brand template palette: ${filters.palette}`);
  }
  if (filters.kind && !JOB_KINDS.includes(filters.kind)) {
    throw new Error(`Unknown brand template job kind: ${filters.kind}`);
  }

  const jobs = createRenderJobs().filter(
    (job) =>
      (!filters.kind || job.kind === filters.kind) &&
      (!filters.preset || job.preset === filters.preset) &&
      (!filters.treatment || job.treatment === filters.treatment) &&
      (!filters.palette || job.palette === filters.palette) &&
      (!filters.example || job.example === filters.example) &&
      (!filters.platform || job.platform === filters.platform) &&
      (!filters.variant || job.variant === filters.variant) &&
      (!("card" in filters) || job.card === filters.card),
  );
  if (jobs.length === 0) {
    throw new Error("No render jobs match the requested filters");
  }
  return { jobs, desktop };
}

export function pngMetadata(buffer) {
  if (
    buffer.length < 26 ||
    buffer[0] !== 0x89 ||
    buffer.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("not a PNG");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

export function thumbnailDimensions(
  width,
  height,
  maxWidth = 340,
  maxHeight = 190,
) {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function assertAlphaSummary(preset, { centerAlpha, edgeAlpha }) {
  if (preset === "stream-overlay") {
    if (centerAlpha !== 0) {
      throw new Error(
        `${preset}: center must be fully transparent, got alpha ${centerAlpha}`,
      );
    }
    if (edgeAlpha === 0) {
      throw new Error(`${preset}: edges must contain visible pixels`);
    }
    return;
  }
  if (centerAlpha !== 255) {
    throw new Error(
      `${preset}: center must be opaque, got alpha ${centerAlpha}`,
    );
  }
}

function assertDimensions(job, buffer) {
  const actual = pngMetadata(buffer);
  if (actual.width !== job.width || actual.height !== job.height) {
    throw new Error(
      `${jobKey(job)}: expected ${job.width}x${job.height}, got ${actual.width}x${actual.height}`,
    );
  }
  if (job.transparent && ![4, 6].includes(actual.colorType)) {
    throw new Error(`${jobKey(job)}: PNG does not contain an alpha channel`);
  }
}

async function waitForServer(baseUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/brand-template/og`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Brand template server did not become ready: ${lastError?.message ?? "timeout"}`,
  );
}

async function inspectPixels(page, buffer, width, height) {
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const thumbnail = thumbnailDimensions(width, height);
  return page.evaluate(
    async ({
      source,
      imageWidth,
      imageHeight,
      thumbnailWidth,
      thumbnailHeight,
    }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not create 2D canvas context");
      context.drawImage(image, 0, 0);
      const centerAlpha = context.getImageData(
        Math.floor(imageWidth / 2),
        Math.floor(imageHeight / 2),
        1,
        1,
      ).data[3];
      const pixels = context.getImageData(0, 0, imageWidth, imageHeight).data;
      let edgeAlpha = 0;
      const edgeX = imageWidth * 0.16;
      const edgeY = imageHeight * 0.16;
      for (let y = 0; y < imageHeight; y += 8) {
        for (let x = 0; x < imageWidth; x += 8) {
          if (
            x > edgeX &&
            x < imageWidth - edgeX &&
            y > edgeY &&
            y < imageHeight - edgeY
          ) {
            continue;
          }
          edgeAlpha = Math.max(edgeAlpha, pixels[(y * imageWidth + x) * 4 + 3]);
        }
      }
      const thumbnailCanvas = document.createElement("canvas");
      thumbnailCanvas.width = thumbnailWidth;
      thumbnailCanvas.height = thumbnailHeight;
      const thumbnailContext = thumbnailCanvas.getContext("2d");
      if (!thumbnailContext) {
        throw new Error("Could not create thumbnail canvas context");
      }
      thumbnailContext.drawImage(image, 0, 0, thumbnailWidth, thumbnailHeight);
      return {
        centerAlpha,
        edgeAlpha,
        thumbnailDataUrl: thumbnailCanvas.toDataURL("image/png"),
      };
    },
    {
      source: dataUrl,
      imageWidth: width,
      imageHeight: height,
      thumbnailWidth: thumbnail.width,
      thumbnailHeight: thumbnail.height,
    },
  );
}

async function assertCanvasIsIsolated(page) {
  const offenders = await page.evaluate(() => {
    const canvas = document.querySelector("[data-brand-template-canvas]");
    if (!(canvas instanceof HTMLElement)) return ["missing canvas"];
    const bounds = canvas.getBoundingClientRect();
    return Array.from(document.body.querySelectorAll("*"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (canvas.contains(element) || element.contains(canvas)) return false;
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < bounds.right &&
          rect.right > bounds.left &&
          rect.top < bounds.bottom &&
          rect.bottom > bounds.top
        );
      })
      .slice(0, 5)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
      );
  });
  if (offenders.length > 0) {
    throw new Error(
      `Visible elements overlap the brand canvas: ${offenders.join(", ")}`,
    );
  }
}

async function assertContentFits(page, job) {
  const failure = await page.evaluate(() => {
    const root = document.querySelector("[data-brand-content]");
    if (!(root instanceof HTMLElement)) return "content root is missing";
    if (
      root.scrollWidth > root.clientWidth + 1 ||
      root.scrollHeight > root.clientHeight + 1
    ) {
      return `content root scrolls ${root.scrollWidth}x${root.scrollHeight} inside ${root.clientWidth}x${root.clientHeight}`;
    }
    const bounds = root.getBoundingClientRect();
    const divider = document.querySelector('[data-brand-frame-line="divider"]');
    if (divider) {
      const dividerBounds = divider.getBoundingClientRect();
      if (bounds.bottom > dividerBounds.top + 1) {
        return "content root crosses the lower divider";
      }
    }
    for (const element of root.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (
        rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1 ||
        rect.top < bounds.top - 1 ||
        rect.bottom > bounds.bottom + 1
      ) {
        return `${element.tagName.toLowerCase()} exceeds the content safe area`;
      }
    }
    const body = root.querySelector("[data-brand-content-body]");
    const footer = root.querySelector("[data-brand-content-footer]");
    if (body && footer) {
      const bodyBounds = body.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      const contentBottom = Math.max(
        bodyBounds.bottom,
        ...Array.from(
          body.querySelectorAll("*"),
          (element) => element.getBoundingClientRect().bottom,
        ),
      );
      if (contentBottom > footerBounds.top - 1) {
        return "content body overlaps the footer";
      }
    }
    return null;
  });
  if (failure) throw new Error(`${jobKey(job)}: ${failure}`);
}

async function isolateCanvas(page) {
  await page.evaluate(() => {
    const canvas = document.querySelector("[data-brand-template-canvas]");
    if (!(canvas instanceof HTMLElement)) {
      throw new Error("Brand template canvas is missing");
    }
    for (const element of document.body.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement)) continue;
      if (canvas.contains(element) || element.contains(canvas)) continue;
      element.style.setProperty("display", "none", "important");
    }
  });
}

function startServer(port) {
  return spawn(
    "pnpm",
    ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", port],
    { cwd: docsRoot, env: process.env, stdio: "inherit" },
  );
}

async function writeAsset(relativePath, buffer, desktopRoot) {
  const repositoryPath = join(outputRoot, relativePath);
  await mkdir(dirname(repositoryPath), { recursive: true });
  await writeFile(repositoryPath, buffer);
  if (desktopRoot) {
    const desktopPath = join(desktopRoot, relativePath);
    await mkdir(dirname(desktopPath), { recursive: true });
    await writeFile(desktopPath, buffer);
  }
}

async function renderJob(browser, baseUrl, job, desktopRoot) {
  const context = await browser.newContext({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    for (const routePattern of INTERCEPTED_ROUTES) {
      await page.route(routePattern, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: routePattern.includes("get-session") ? "null" : "{}",
        }),
      );
    }
    const query = new URLSearchParams();
    if (job.kind === "example") {
      query.set("example", job.example);
    } else if (job.kind === "campaign") {
      query.set("platform", job.platform);
      query.set("variant", job.variant);
      query.set("card", String(job.card));
    } else {
      query.set("treatment", job.treatment);
      query.set("palette", job.palette);
    }
    await page.goto(`${baseUrl}/brand-template/${job.preset}?${query}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector('[data-brand-template-ready="true"]');
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images, (image) =>
          image.complete ? Promise.resolve() : image.decode(),
        ),
      );
    });
    await page.waitForFunction(() => {
      const resources = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name);
      return ["thermal-1.webp", "thermal-2.webp"].every((asset) =>
        resources.some((resource) => resource.includes(asset)),
      );
    });
    await isolateCanvas(page);
    await assertCanvasIsIsolated(page);
    if (job.kind !== "template") await assertContentFits(page, job);

    const canvas = page.locator("[data-brand-template-canvas]");
    const buffer = await canvas.screenshot({
      animations: "disabled",
      omitBackground: true,
      type: "png",
    });
    if (job.kind === "campaign" && buffer.length > 10 * 1024 * 1024) {
      throw new Error(`${jobKey(job)}: PNG exceeds 10 MB`);
    }
    assertDimensions(job, buffer);
    const inspection = await inspectPixels(page, buffer, job.width, job.height);
    assertAlphaSummary(job.preset, inspection);
    const thumbnail = Buffer.from(
      inspection.thumbnailDataUrl.slice(
        inspection.thumbnailDataUrl.indexOf(",") + 1,
      ),
      "base64",
    );
    const relativePath = outputRelativePath(job);
    await writeAsset(relativePath, buffer, desktopRoot);
    process.stdout.write(
      `rendered ${relativePath} (${job.width}x${job.height})\n`,
    );
    return { job, relativePath, buffer, thumbnail };
  } finally {
    await context.close();
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function createContactSheet(
  browser,
  rendered,
  desktopRoot,
  relativePath = "contact-sheet.png",
) {
  if (rendered.length === 0) return;
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const assets = new Map(
    rendered.map(({ relativePath, thumbnail }) => [relativePath, thumbnail]),
  );
  await page.route("https://brand-template-assets.local/**", async (route) => {
    const relativePath = decodeURIComponent(
      new URL(route.request().url()).pathname.slice(1),
    );
    const body = assets.get(relativePath);
    if (!body) return route.abort();
    return route.fulfill({ status: 200, contentType: "image/png", body });
  });

  const cards = rendered
    .map(
      ({ relativePath }) => `
        <figure>
          <img src="https://brand-template-assets.local/${encodeURIComponent(relativePath)}" alt="" />
          <figcaption>${escapeHtml(relativePath)}</figcaption>
        </figure>`,
    )
    .join("");
  await page.setContent(`<!doctype html>
    <html><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 32px; background: #090606; color: #d8ceca; font: 12px ui-monospace, monospace; }
      main { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
      figure { margin: 0; padding: 10px; background: #130d0c; border: 1px solid #3a2420; border-radius: 8px; }
      img { display: block; width: 100%; height: 190px; object-fit: contain; background: repeating-conic-gradient(#171313 0 25%, #0a0808 0 50%) 0 / 20px 20px; }
      figcaption { margin-top: 9px; overflow-wrap: anywhere; line-height: 1.35; }
    </style></head><body><main>${cards}</main></body></html>`);
  await page.evaluate(async () => {
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
  const buffer = await page.screenshot({ fullPage: true, type: "png" });
  await writeAsset(relativePath, buffer, desktopRoot);
  await context.close();
}

async function writeManifest(rendered, desktopRoot) {
  const entries = rendered.map(({ job, relativePath }) => ({
    kind: job.kind,
    path: relativePath,
    preset: job.preset,
    palette: job.palette,
    width: job.width,
    height: job.height,
    transparent: job.transparent,
    ...(job.kind === "template" ? { treatment: job.treatment } : {}),
    ...(job.kind === "example" ? { example: job.example } : {}),
    ...(job.kind === "campaign"
      ? {
          platform: job.platform,
          variant: job.variant,
          card: job.card,
          role: job.role,
        }
      : {}),
  }));
  if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
    throw new Error("Render manifest contains duplicate paths");
  }
  const contents = `${JSON.stringify({ count: entries.length, images: entries }, null, 2)}\n`;
  await writeFile(join(outputRoot, "manifest.json"), contents);
  if (desktopRoot) {
    await writeFile(join(desktopRoot, "manifest.json"), contents);
  }
}

async function main() {
  const { jobs, desktop } = parseRenderArguments(process.argv.slice(2));
  await mkdir(outputRoot, { recursive: true });
  const desktopRoot = desktop
    ? (process.env.BRAND_TEMPLATE_DESKTOP_ROOT ?? defaultDesktopRoot)
    : undefined;
  if (desktopRoot) await mkdir(desktopRoot, { recursive: true });

  const port = process.env.BRAND_TEMPLATE_PORT ?? "3015";
  const providedBaseUrl = process.env.BRAND_TEMPLATE_BASE_URL;
  const baseUrl = providedBaseUrl ?? `http://127.0.0.1:${port}`;
  const server = providedBaseUrl ? undefined : startServer(port);
  const stopServer = () => server?.kill("SIGTERM");
  process.once("SIGINT", stopServer);
  process.once("SIGTERM", stopServer);

  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch();
    const rendered = [];
    for (const job of jobs) {
      rendered.push(await renderJob(browser, baseUrl, job, desktopRoot));
    }
    if (
      jobs.length === 92 &&
      new Set(rendered.map(({ relativePath }) => relativePath)).size !== 92
    ) {
      throw new Error("Complete render did not produce 92 unique PNG paths");
    }
    await writeManifest(rendered, desktopRoot);
    await createContactSheet(browser, rendered, desktopRoot);
    await createContactSheet(
      browser,
      rendered.filter(({ job }) => job.kind === "example"),
      desktopRoot,
      "contact-sheets/examples.png",
    );
    for (const platform of Object.keys(CAMPAIGNS)) {
      await createContactSheet(
        browser,
        rendered.filter(
          ({ job }) => job.kind === "campaign" && job.platform === platform,
        ),
        desktopRoot,
        `contact-sheets/${platform}.png`,
      );
    }
    await createContactSheet(
      browser,
      rendered.filter(({ job }) => job.kind === "campaign"),
      desktopRoot,
      "contact-sheets/campaigns.png",
    );
    process.stdout.write(`manifest: ${join(outputRoot, "manifest.json")}\n`);
    process.stdout.write(
      `contact sheet: ${join(outputRoot, "contact-sheet.png")}\n`,
    );
    if (desktopRoot) process.stdout.write(`desktop export: ${desktopRoot}\n`);
  } finally {
    await browser?.close();
    stopServer();
    process.removeListener("SIGINT", stopServer);
    process.removeListener("SIGTERM", stopServer);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
