import type { ReactElement } from "react";
import { render } from "react-email";

export async function renderToHtml(element: ReactElement): Promise<string> {
  return render(element);
}

export async function renderToPlainText(
  element: ReactElement,
): Promise<string> {
  return render(element, { plainText: true });
}
