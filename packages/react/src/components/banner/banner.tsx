"use client";

/**
 * `<Banner>` — the default render for an on-site banner slot. Renders the single
 * highest-priority visible banner (`current`) — standard banner UX. Fully
 * styleable via the five-layer surface (plan §6):
 *   1. `--hs-banner-*` CSS vars
 *   2. `className` + per-slot `classNames={{ root, content, title, body, action, dismiss }}`
 *   3. `data-*` state (`data-placement`, `data-state`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. `renderBanner` replaces the WHOLE banner
 *
 * `autoCapture` (default true) fires `banner.shown` once per banner on first
 * render of `current` — the ONE component-level emit (a banner that never
 * renders was never "shown"). `click`/`dismiss` emission lives in the SDK store
 * mutation, so a headless consumer can't opt out of those triggers.
 */

import type { Banner as BannerData } from "@hogsend/js";
import { type ReactNode, useContext, useEffect, useRef } from "react";
import { useBanner } from "../../hooks/use-banner.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { HogsendContext } from "../../provider/context.js";
import { Slot } from "../primitives/slot.js";

/** Where the banner sits. */
export type BannerPlacement = "top" | "bottom" | "inline";

/** Per-slot class overrides for {@link Banner}. */
export interface BannerClassNames {
  root?: string;
  content?: string;
  title?: string;
  body?: string;
  action?: string;
  dismiss?: string;
}

/** Helpers passed to {@link BannerProps.renderBanner}. */
export interface BannerRenderHelpers {
  onClick: () => void;
  onDismiss: () => void;
}

/** Props for {@link Banner}. */
export interface BannerProps {
  /** Banner slot (default "default"). Maps to the `banner:<slot>` feed. */
  slot?: string;
  /** Placement (drives `data-placement` + the default skin). Default "top". */
  placement?: BannerPlacement;
  /** Replace the whole banner markup (override layer 5). */
  renderBanner?: (
    banner: BannerData,
    helpers: BannerRenderHelpers,
  ) => ReactNode;
  /** Fired AFTER `banner.clicked` is emitted. */
  onClick?: (banner: BannerData) => void;
  /** Fired AFTER `banner.dismissed` is emitted. */
  onDismiss?: (banner: BannerData) => void;
  /** Emit `banner.shown` on first render of `current`. Default true. */
  autoCapture?: boolean;
  /** Merge props onto a consumer element (override layer 4). */
  asChild?: boolean;
  className?: string;
  classNames?: BannerClassNames;
  "aria-label"?: string;
}

export function Banner(props: BannerProps): ReactNode {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("Banner must be used within <HogsendProvider>");
  }
  const client = ctx.client;

  const {
    slot = "default",
    placement = "top",
    renderBanner,
    onClick,
    onDismiss,
    autoCapture = true,
    asChild = false,
    className,
    classNames,
    "aria-label": ariaLabel,
  } = props;

  const { current, dismiss, click } = useBanner(slot);

  // ── banner.shown — the one component-level emit, once per banner id ──
  const shownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoCapture || !current) return;
    if (shownRef.current === current.id) return;
    shownRef.current = current.id;
    void client.capture("banner.shown", { slot, bannerId: current.id });
  }, [autoCapture, client, current, slot]);

  if (!current) return null;

  const handleClick = (): void => {
    void click(current.id);
    onClick?.(current);
  };
  const handleDismiss = (): void => {
    void dismiss(current.id);
    onDismiss?.(current);
  };

  if (renderBanner) {
    return (
      <>
        {renderBanner(current, {
          onClick: handleClick,
          onDismiss: handleDismiss,
        })}
      </>
    );
  }

  const stateAttrs = dataVariants({
    placement,
    state: current.dismissed ? "dismissed" : "visible",
  });

  const content = (
    <>
      <div className={cn("hsr-banner__content", classNames?.content)}>
        {current.title ? (
          <div className={cn("hsr-banner__title", classNames?.title)}>
            {current.title}
          </div>
        ) : null}
        {current.body ? (
          <div className={cn("hsr-banner__body", classNames?.body)}>
            {current.body}
          </div>
        ) : null}
      </div>
      {current.actionUrl ? (
        <a
          className={cn("hsr-banner__action", classNames?.action)}
          href={current.actionUrl}
          onClick={(e) => {
            e.stopPropagation();
            handleClick();
          }}
        >
          Open
        </a>
      ) : null}
      <button
        type="button"
        className={cn("hsr-banner__dismiss", classNames?.dismiss)}
        onClick={(e) => {
          e.stopPropagation();
          handleDismiss();
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </>
  );

  const sharedProps = {
    ...stateAttrs,
    className: cn("hsr", "hsr-banner", className, classNames?.root),
    role: "status",
    "aria-label": ariaLabel ?? current.title ?? current.body ?? "Banner",
  } as const;

  if (asChild) {
    return <Slot {...sharedProps}>{content as ReactNode}</Slot>;
  }

  return <div {...sharedProps}>{content}</div>;
}
