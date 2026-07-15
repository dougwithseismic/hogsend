import type { TemplateRegistry } from "@hogsend/email";
import {
  getTemplateDefinition,
  renderToHtml,
  renderToPlainText,
} from "@hogsend/email";
import type { MailboxMessage, RenderedTestEmail } from "./types.js";

export class JourneyMailbox {
  readonly messages: MailboxMessage[] = [];

  constructor(private readonly templates?: TemplateRegistry) {}

  get length(): number {
    return this.messages.length;
  }
  at(index: number): MailboxMessage | undefined {
    return this.messages.at(index);
  }
  [Symbol.iterator](): Iterator<MailboxMessage> {
    return this.messages[Symbol.iterator]();
  }

  async renderEmail(
    template: string,
    occurrence = 1,
  ): Promise<RenderedTestEmail> {
    const message = this.messages.filter(
      (item) => item.channel === "email" && item.template === template,
    )[occurrence - 1];
    if (!message)
      throw new Error(
        `No email "${template}" occurrence ${occurrence} was sent`,
      );
    if (!this.templates)
      throw new Error(
        "renderEmail requires a template registry in createJourneyTest options",
      );
    const definition = getTemplateDefinition({
      key: template as never,
      registry: this.templates,
    }) as {
      component: (
        props: Record<string, unknown>,
      ) => import("react").ReactElement;
      defaultSubject: string;
    };
    const element = definition.component(message.props);
    const [html, text] = await Promise.all([
      renderToHtml(element),
      renderToPlainText(element),
    ]);
    return {
      html,
      text,
      subject: message.subject ?? definition.defaultSubject,
      message,
    };
  }
}
