import assert from "node:assert/strict";
import test from "node:test";
import {
  applyClassNamePreview,
  canPreviewClassName,
  inspectorClickIntent,
  normalizeClassName,
  restoreClassNamePreview,
} from "../src/class-edit.ts";

test("Shift keeps open-in-editor precedence over class editing modifiers", () => {
  assert.equal(
    inspectorClickIntent({ shiftKey: true, metaKey: true, ctrlKey: false }),
    "open",
  );
  assert.equal(
    inspectorClickIntent({ shiftKey: true, metaKey: false, ctrlKey: true }),
    "open",
  );
});

test("Cmd or Ctrl chooses class editing and a plain click keeps text editing", () => {
  assert.equal(
    inspectorClickIntent({ shiftKey: false, metaKey: true, ctrlKey: false }),
    "class",
  );
  assert.equal(
    inspectorClickIntent({ shiftKey: false, metaKey: false, ctrlKey: true }),
    "class",
  );
  assert.equal(
    inspectorClickIntent({
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    }),
    "text",
  );
});

test("class names are normalized to a single token-separated line", () => {
  assert.equal(
    normalizeClassName("  grid   gap-4\n md:grid-cols-2  "),
    "grid gap-4 md:grid-cols-2",
  );
});

test("preview is allowed only when source owns the rendered class list", () => {
  assert.equal(canPreviewClassName("grid  gap-4", "grid gap-4"), true);
  assert.equal(
    canPreviewClassName("grid gap-4", "button-base grid gap-4"),
    false,
  );
  assert.equal(canPreviewClassName("", null), false);
});

function classTarget(initial: string | null) {
  let className = initial;
  return {
    getAttribute(name: string) {
      assert.equal(name, "class");
      return className;
    },
    setAttribute(name: string, value: string) {
      assert.equal(name, "class");
      className = value;
    },
    removeAttribute(name: string) {
      assert.equal(name, "class");
      className = null;
    },
  };
}

test("preview cleanup restores the original class only after its own preview", () => {
  const target = classTarget("grid gap-4");
  const preview = applyClassNamePreview(
    target,
    "  flex   gap-2 ",
    "grid gap-4",
  );

  assert.equal(preview, "flex gap-2");
  assert.equal(target.getAttribute("class"), preview);
  assert.equal(restoreClassNamePreview(target, "grid gap-4", preview), true);
  assert.equal(target.getAttribute("class"), "grid gap-4");

  const untouched = classTarget("runtime-class");
  assert.equal(
    restoreClassNamePreview(untouched, "mount-time-class", null),
    false,
  );
  assert.equal(untouched.getAttribute("class"), "runtime-class");
});

test("preview cleanup does not overwrite a newer runtime class update", () => {
  const target = classTarget("grid");
  const preview = applyClassNamePreview(target, "flex", "grid");
  target.setAttribute("class", "runtime-updated");

  assert.equal(restoreClassNamePreview(target, "grid", preview), false);
  assert.equal(target.getAttribute("class"), "runtime-updated");
});

test("preview cleanup removes a class attribute that did not originally exist", () => {
  const target = classTarget(null);
  const preview = applyClassNamePreview(target, "flex", null);

  assert.equal(restoreClassNamePreview(target, null, preview), true);
  assert.equal(target.getAttribute("class"), null);
});

test("preview refuses to overwrite a runtime class update", () => {
  const target = classTarget("grid gap-4");
  const expectedClassName = target.getAttribute("class");
  target.setAttribute("class", "runtime-class grid gap-4");

  assert.equal(
    applyClassNamePreview(target, "flex gap-2", expectedClassName),
    null,
  );
  assert.equal(target.getAttribute("class"), "runtime-class grid gap-4");
});
