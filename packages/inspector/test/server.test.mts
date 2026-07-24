import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createEditHandler, createStyleHandler } from "../src/server.ts";

type Stamp = { file: string; line: number; col: number };

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function stampFor(source: string, file: string, needle: string): Stamp {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `fixture must contain ${needle}`);
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return {
    file,
    line: lines.length,
    col: (lines.at(-1)?.length ?? 0) + 1,
  };
}

async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hogsend-inspector-"));
  const file = "components/card.tsx";
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, source, "utf8");
  return {
    root,
    file,
    absolute,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function styleRequest(
  handler: ReturnType<typeof createStyleHandler>,
  body: unknown,
) {
  return handler(
    new Request("http://localhost/api/devtools/style", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(body),
    }),
  );
}

function editRequest(
  handler: ReturnType<typeof createEditHandler>,
  body: unknown,
) {
  return handler(
    new Request("http://localhost/api/devtools/edit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(body),
    }),
  );
}

test("inspect returns the nearest static className and its exact target", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="grid gap-4 p-6">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "inspect",
      target,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      target,
      className: "grid gap-4 p-6",
    });
  } finally {
    await fx.cleanup();
  }
});

test("inspect refuses the exact target instead of falling through to an ancestor", async () => {
  const source = [
    "export function Card({ titleClass }: { titleClass: string }) {",
    "  return (",
    '    <section className="rounded-xl p-6">',
    "      <h2 className={titleClass}>Hello</h2>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<h2");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "inspect",
      target,
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "no static className found",
    });
  } finally {
    await fx.cleanup();
  }
});

test("write replaces only the targeted className value", async () => {
  const source = [
    "export function Card() {",
    "  return (",
    '    <main className="p-4">',
    '      <section className="p-4">Hello</section>',
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: "p-4",
      className: "rounded-2xl bg-white p-8 shadow-lg",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      target,
      className: "rounded-2xl bg-white p-8 shadow-lg",
    });
    assert.equal(
      await readFile(fx.absolute, "utf8"),
      source.replace(
        '<section className="p-4">',
        '<section className="rounded-2xl bg-white p-8 shadow-lg">',
      ),
    );
  } finally {
    await fx.cleanup();
  }
});

test("write switches quote style instead of entity-escaping Tailwind content", async () => {
  const source = [
    "export function Card() {",
    "  return <section className='before:content-[\"new\"] p-4'>Hi</section>;",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: 'before:content-["new"] p-4',
      className: "before:content-['saved'] p-6",
    });

    assert.equal(response.status, 200);
    assert.match(
      await readFile(fx.absolute, "utf8"),
      /className="before:content-\['saved'\] p-6"/,
    );
    const reread = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "inspect",
      target,
    });
    assert.equal(reread.status, 200);
    assert.equal(
      ((await reread.json()) as { className?: string }).className,
      "before:content-['saved'] p-6",
    );
  } finally {
    await fx.cleanup();
  }
});

test("write preserves raw Tailwind arbitrary selector variants", async () => {
  const source = [
    "export function Icon() {",
    '  return <span className="[&>svg]:size-4">Icon</span>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<span");
    const className = "[&>svg]:size-5 [&::-webkit-scrollbar]:hidden text-white";
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: "[&>svg]:size-4",
      className,
    });

    assert.equal(response.status, 200);
    const written = await readFile(fx.absolute, "utf8");
    assert.match(written, /\[&>svg\]:size-5/);
    assert.match(written, /\[&::-webkit-scrollbar\]:hidden/);
    assert.doesNotMatch(written, /&amp;|&gt;/);

    const reread = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "inspect",
      target,
    });
    assert.equal(
      ((await reread.json()) as { className?: string }).className,
      className,
    );
  } finally {
    await fx.cleanup();
  }
});

test("write rejects JSX entities that would cook to a different class list", async () => {
  const source = [
    "export function Icon() {",
    "  return <span className=\"before:content-['new']\">Icon</span>;",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<span");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: "before:content-['new']",
      className: "before:content-['&copy;']",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error:
        "className does not round-trip as a static JSX string; open the source editor for this value",
    });
    assert.equal(await readFile(fx.absolute, "utf8"), source);
  } finally {
    await fx.cleanup();
  }
});

test("write aborts when the source class list has changed", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-6">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: "p-4",
      className: "p-8",
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "class list changed",
      className: "p-6",
    });
    assert.equal(await readFile(fx.absolute, "utf8"), source);
  } finally {
    await fx.cleanup();
  }
});

test("concurrent writes serialize so only one stale-checked save succeeds", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-4">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const handler = createStyleHandler({ root: fx.root });
    const responses = await Promise.all([
      styleRequest(handler, {
        action: "write",
        target,
        expectedClassName: "p-4",
        className: "p-6",
      }),
      styleRequest(handler, {
        action: "write",
        target,
        expectedClassName: "p-4",
        className: "p-8",
      }),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);

    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ ok?: boolean; className?: string }>;
    const saved = bodies.find((body) => body.ok)?.className;
    assert.ok(saved);
    assert.match(await readFile(fx.absolute, "utf8"), new RegExp(`"${saved}"`));
  } finally {
    await fx.cleanup();
  }
});

test("style handling refuses a symlink that resolves outside the project root", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-4">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const root = await mkdtemp(path.join(os.tmpdir(), "hogsend-inspector-root-"));
  const outside = await fixture(source);
  const linkedFile = "components/linked.tsx";
  const linkedAbsolute = path.join(root, linkedFile);
  await mkdir(path.dirname(linkedAbsolute), { recursive: true });
  await symlink(outside.absolute, linkedAbsolute);

  try {
    const target = stampFor(source, linkedFile, "<section");
    const response = await styleRequest(createStyleHandler({ root }), {
      action: "write",
      target,
      expectedClassName: "p-4",
      className: "p-8",
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "path not allowed" });
    assert.equal(await readFile(outside.absolute, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
    await outside.cleanup();
  }
});

test("symlink aliases share one stale-checked write lock", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-4">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);
  const alias = "components/card-alias.tsx";
  await symlink(fx.absolute, path.join(fx.root, alias));

  try {
    const handler = createStyleHandler({ root: fx.root });
    const target = stampFor(source, fx.file, "<section");
    const aliasTarget = { ...target, file: alias };
    const responses = await Promise.all([
      styleRequest(handler, {
        action: "write",
        target,
        expectedClassName: "p-4",
        className: "p-6",
      }),
      styleRequest(handler, {
        action: "write",
        target: aliasTarget,
        expectedClassName: "p-4",
        className: "p-8",
      }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
  } finally {
    await fx.cleanup();
  }
});

test("text and class edits share one atomic source mutation path", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-4">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const [styleResponse, textResponse] = await Promise.all([
      styleRequest(createStyleHandler({ root: fx.root }), {
        action: "write",
        target,
        expectedClassName: "p-4",
        className: "p-8",
      }),
      editRequest(createEditHandler({ root: fx.root }), {
        candidates: [target],
        edits: [{ index: 0, expectedOld: "Hello", newText: "Goodbye" }],
      }),
    ]);

    assert.equal(styleResponse.status, 200);
    assert.equal(textResponse.status, 200);
    assert.match(
      await readFile(fx.absolute, "utf8"),
      /className="p-8">Goodbye<\/section>/,
    );
  } finally {
    await fx.cleanup();
  }
});

test("text editing rejects duplicate patches for the same source range", async () => {
  const source = [
    "export function Card() {",
    "  return <section>Hello</section>;",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await editRequest(createEditHandler({ root: fx.root }), {
      candidates: [target],
      edits: [
        { index: 0, expectedOld: "Hello", newText: "First" },
        { index: 1, expectedOld: "Hello", newText: "Second" },
      ],
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "overlapping text edits",
    });
    assert.equal(await readFile(fx.absolute, "utf8"), source);
  } finally {
    await fx.cleanup();
  }
});

test("write dry-run validates the edit without touching the file", async () => {
  const source = [
    "export function Card() {",
    '  return <section className="p-4">Hello</section>;',
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "write",
      target,
      expectedClassName: "p-4",
      className: "p-8",
      dryRun: true,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      dryRun: true,
      target,
      className: "p-8",
    });
    assert.equal(await readFile(fx.absolute, "utf8"), source);
  } finally {
    await fx.cleanup();
  }
});

test("inspect refuses elements without a static className string", async () => {
  const source = [
    "export function Card({ classes }: { classes: string }) {",
    "  return <section className={classes}>Hello</section>;",
    "}",
    "",
  ].join("\n");
  const fx = await fixture(source);

  try {
    const target = stampFor(source, fx.file, "<section");
    const response = await styleRequest(createStyleHandler({ root: fx.root }), {
      action: "inspect",
      target,
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      reason: "no static className found",
    });
  } finally {
    await fx.cleanup();
  }
});

test("style handling hard-404s in production before checking origin or input", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await createStyleHandler({ root: process.cwd() })(
      new Request("http://localhost/api/devtools/style", {
        method: "POST",
        body: "not json",
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("style handling hard-404s when NODE_ENV is not development", async () => {
  const previous = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const response = await createStyleHandler({ root: process.cwd() })(
      new Request("http://localhost/api/devtools/style", {
        method: "POST",
        body: "not json",
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("style handling rejects a non-object JSON payload", async () => {
  const response = await styleRequest(
    createStyleHandler({ root: process.cwd() }),
    null,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid body" });
});
