import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * Resolve a `<Object>.<member>` reference (e.g. `Templates.CHURN_PAYMENT_FAILED`)
 * to its authored string-literal value by statically following the import graph
 * — a pure syntax walk over `.ts` files on disk (no type-checker, no execution).
 *
 * This is how the journey-graph extractor turns an authored `template:
 * Templates.CHURN_PAYMENT_FAILED` into the concrete key `churn-payment-failed`,
 * so Studio can join a flow node to observed `email_sends` reliably instead of
 * fuzzy-matching a display string.
 *
 * Best-effort by design: only relative imports are followed, re-exports
 * (`export { X } from "./y.js"`, `export * from "./y.js"`) are chased up to a
 * small depth, and anything computed at runtime resolves to `undefined`.
 */

/** Depth cap on the module-hop chase (journey → constants/index → templates). */
const MAX_HOPS = 6;

/** Parse a file into a SourceFile, or undefined if it can't be read. */
function parse(file: string): ts.SourceFile | undefined {
  try {
    const text = readFileSync(file, "utf8");
    return ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  } catch {
    return undefined;
  }
}

/**
 * Resolve a relative module specifier (as written in an import/export) to a
 * concrete `.ts` file on disk. Handles the ESM `.js` → `.ts` rewrite this repo
 * uses and directory `index.ts` barrels. Returns undefined for bare (npm)
 * specifiers or when nothing matches.
 */
function resolveModule(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined; // npm/bare — not followed.
  const base = dirname(fromFile);
  const target = resolve(base, spec);
  const candidates = [
    target.replace(/\.js$/, ".ts"),
    `${target}.ts`,
    `${target}/index.ts`,
    target.replace(/\.js$/, "/index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** The string value of an object-literal member, if it's a string literal. */
function memberLiteral(
  obj: ts.ObjectLiteralExpression,
  member: string,
): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === member) {
      const init = p.initializer;
      if (ts.isStringLiteral(init)) return init.text;
      if (ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
      return undefined;
    }
  }
  return undefined;
}

/** Unwrap `<expr> as const` / `<expr> as T` to the underlying expression. */
function unwrapAs(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  return e;
}

/**
 * Find the object literal bound to `objectName` reachable from `file` — either
 * a local `export const objectName = { ... }` or, transitively, one behind a
 * re-export. Returns the object literal + the file it was found in.
 */
function findObjectLiteral(
  file: string,
  objectName: string,
  visited: Set<string>,
  hopsLeft: number,
): ts.ObjectLiteralExpression | undefined {
  if (hopsLeft <= 0 || visited.has(file)) return undefined;
  visited.add(file);
  const sf = parse(file);
  if (!sf) return undefined;

  const reexports: string[] = []; // specifiers to chase if not found locally.
  let found: ts.ObjectLiteralExpression | undefined;

  for (const stmt of sf.statements) {
    // Local: `export const Templates = { ... } as const` (or non-exported).
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === objectName &&
          d.initializer
        ) {
          const init = unwrapAs(d.initializer);
          if (ts.isObjectLiteralExpression(init)) {
            found = init;
          }
        }
      }
    }
    // Re-export: `export { Templates } from "./templates.js"` — note the spec
    // if it names our object. `export * from "..."` is chased unconditionally.
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!stmt.exportClause) {
        reexports.push(spec); // export * from "..."
      } else if (ts.isNamedExports(stmt.exportClause)) {
        const names = stmt.exportClause.elements.map((e) => e.name.text);
        if (names.includes(objectName)) reexports.push(spec);
      }
    }
    // Import then bare re-export: `import { Templates } from "./x.js"` used by
    // a later `export { Templates }` — follow the import specifier.
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)
    ) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const names = stmt.importClause.namedBindings.elements.map(
        (e) => e.name.text,
      );
      if (names.includes(objectName)) reexports.push(spec);
    }
    if (found) break;
  }

  if (found) return found;

  for (const spec of reexports) {
    const next = resolveModule(file, spec);
    if (!next) continue;
    const hit = findObjectLiteral(next, objectName, visited, hopsLeft - 1);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolve `<objectName>.<memberName>` to its string-literal value, starting the
 * import-graph walk from `fromFile`. Returns undefined when unresolvable.
 */
export function resolveMemberLiteral(
  fromFile: string,
  objectName: string,
  memberName: string,
): string | undefined {
  const obj = findObjectLiteral(fromFile, objectName, new Set(), MAX_HOPS);
  if (!obj) return undefined;
  return memberLiteral(obj, memberName);
}
