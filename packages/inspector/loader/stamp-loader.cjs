/**
 * @hogsend/inspector — build-time source stamper (dev only).
 *
 * A Turbopack/webpack loader that adds a `data-hs-source="file:line:col"`
 * attribute to every JSX element. This is the load-bearing half of the
 * inspector: under React 19 + Turbopack a rendered DOM node carries NO path
 * back to its source (no `_debugSource`, no source attrs), so the only way to
 * map a clicked element to a file is to stamp it at compile time.
 *
 * It is a MINIMAL source-to-source pass: parse the TSX, capture each element's
 * ORIGINAL line:col, inject one attribute, and reprint STILL-VALID TSX. The
 * result is handed back to the bundler, whose own transform does the real
 * compile — so we add a light attribute pass, not a second full transpile. The
 * stamped value is read from the original AST, so it stays correct regardless
 * of reprinting.
 *
 * Fails OPEN: any parse/print error returns the source untouched, so a hiccup
 * in this dev tool can never break the build. The config wrapper only wires it
 * in development, so it never runs in a production build.
 *
 * Options (from `withInspector`):
 *   - root:    absolute path the stamped paths are made relative to (app cwd)
 *   - include: array of path fragments; a file is stamped only if its path
 *              contains one of them (default ["/components/"])
 */

const path = require("node:path");
const { parse } = require("@babel/parser");

const traverseMod = require("@babel/traverse");
const traverse = traverseMod.default || traverseMod;
const generateMod = require("@babel/generator");
const generate = generateMod.default || generateMod;
const t = require("@babel/types");

const ATTR = "data-hs-source";
const DEFAULT_INCLUDE = ["/components/"];

function shouldStamp(filename, include) {
  if (!filename) return false;
  if (filename.includes("node_modules")) return false;
  if (!/\.(t|j)sx$/.test(filename)) return false;
  const norm = filename.split(path.sep).join("/");
  return include.some((frag) => norm.includes(frag));
}

module.exports = function hogsendStampLoader(source) {
  // Belt-and-suspenders: never stamp in production, even if a consumer wired
  // this loader directly instead of through withInspector (which already omits
  // the rule in prod). In dev NODE_ENV is never "production", so this never fires.
  if (process.env.NODE_ENV === "production") return source;

  const filename = this.resourcePath;
  const options =
    (typeof this.getOptions === "function" ? this.getOptions() : this.query) ||
    {};
  const include =
    Array.isArray(options.include) && options.include.length
      ? options.include
      : DEFAULT_INCLUDE;

  if (!shouldStamp(filename, include)) return source;

  const root = options.root || process.cwd();
  const rel = path.relative(root, filename).split(path.sep).join("/");

  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return source;
  }

  let changed = false;
  try {
    traverse(ast, {
      JSXOpeningElement(nodePath) {
        const node = nodePath.node;
        if (!node.loc) return;
        const already = node.attributes.some(
          (a) => t.isJSXAttribute(a) && a.name && a.name.name === ATTR,
        );
        if (already) return;
        const value = `${rel}:${node.loc.start.line}:${node.loc.start.column + 1}`;
        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(ATTR), t.stringLiteral(value)),
        );
        changed = true;
      },
    });
  } catch {
    return source;
  }

  if (!changed) return source;

  try {
    return generate(ast, { retainLines: true }, source).code;
  } catch {
    return source;
  }
};
