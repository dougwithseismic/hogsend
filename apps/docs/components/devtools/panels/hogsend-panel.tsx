"use client";

import {
  HOGSEND_API_URL,
  HOGSEND_PUBLISHABLE_KEY,
  isHogsendConfigured,
  OPEN_FEED_EVENT,
} from "@/components/hogsend/config";
import { Button, Empty, PanelShell, Pill, Row, Section } from "./panel-ui";

/**
 * HogsendDevtoolsPanel — a second PRODUCT-specific panel, kept intentionally
 * small to show that panels compose: each is an independent leaf in the shell's
 * `plugins` array, so a lean one sits next to the rich analytics one at no cost.
 *
 * It surfaces the Hogsend client config (the `@hogsend/react` feed/bell layer)
 * and offers a dev action to pop the nav feed open without hunting for the bell.
 */

/** Show a `pk_` key as `pk_1234…cdef` — enough to recognise, never the secret. */
function maskKey(key: string): string {
  if (!key) return "—";
  if (key.length <= 12) return key;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export function HogsendDevtoolsPanel() {
  const popFeed = () => {
    try {
      window.dispatchEvent(new Event(OPEN_FEED_EVENT));
    } catch {
      // No window (shouldn't happen in a client panel) — ignore.
    }
  };

  return (
    <PanelShell>
      <Section title="Hogsend client">
        <Row
          label="configured"
          value={
            <Pill ok={isHogsendConfigured}>
              {isHogsendConfigured ? "yes" : "no"}
            </Pill>
          }
        />
        <Row label="api_url" value={HOGSEND_API_URL || "—"} mono />
        <Row
          label="publishable_key"
          value={maskKey(HOGSEND_PUBLISHABLE_KEY)}
          mono
        />
      </Section>

      <Section title="Actions">
        {isHogsendConfigured ? (
          <Button onClick={popFeed}>Pop nav feed ({OPEN_FEED_EVENT})</Button>
        ) : (
          <Empty>
            Set NEXT_PUBLIC_HOGSEND_API_URL and a pk_ key to enable the feed.
          </Empty>
        )}
      </Section>
    </PanelShell>
  );
}
