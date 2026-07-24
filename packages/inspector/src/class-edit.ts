type ClickModifiers = {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
};

export type InspectorClickIntent = "text" | "class" | "open";

export function inspectorClickIntent({
  shiftKey,
  metaKey,
  ctrlKey,
}: ClickModifiers): InspectorClickIntent {
  if (shiftKey) return "open";
  if (metaKey || ctrlKey) return "class";
  return "text";
}

export function normalizeClassName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function canPreviewClassName(
  sourceClassName: string,
  renderedClassName: string | null,
): boolean {
  if (renderedClassName === null) return false;
  return (
    normalizeClassName(sourceClassName) ===
    normalizeClassName(renderedClassName)
  );
}

type ClassAttributeTarget = {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function applyClassNamePreview(
  target: ClassAttributeTarget,
  value: string,
  expectedClassName: string | null,
): string | null {
  if (target.getAttribute("class") !== expectedClassName) return null;
  const normalized = normalizeClassName(value);
  target.setAttribute("class", normalized);
  return normalized;
}

export function restoreClassNamePreview(
  target: ClassAttributeTarget,
  originalClassName: string | null,
  lastPreviewClassName: string | null,
): boolean {
  if (
    lastPreviewClassName === null ||
    target.getAttribute("class") !== lastPreviewClassName
  ) {
    return false;
  }

  if (originalClassName === null) target.removeAttribute("class");
  else target.setAttribute("class", originalClassName);
  return true;
}
