"use client";

/**
 * `<PreferenceCenter>` — the list/category opt-in surface, over
 * {@link usePreferences}. Usable standalone OR bundled as a tab inside
 * `<FeedPopover preferences>` (the Novu `<Inbox/>` pattern).
 *
 * Three layouts from one component:
 *   - default/flat (no `channels`, no channel-kind lists): one row per list with
 *     a single on/off switch driving `setPreference(list.id, next)`.
 *   - sectioned (`layout: "auto"`, the default, when the catalog carries
 *     `kind: "channel"` lists): a "Channels" section (a synthetic Email master
 *     row wired to `unsubscribedAll`, then the channel lists) above a "Topics"
 *     section. An OLD engine emits no `kind`, so no channel lists surface and the
 *     body is byte-identical to flat. Force flat with `layout: "flat"`.
 *   - matrix (`channels` supplied): a category×channel grid. Takes precedence
 *     over sectioning. The backend stays a FLAT `categories` map
 *     (migration-free) — per-channel is realized by distinct category ids via
 *     `resolveCategoryId(listId, channelId)` (default: a `primary` channel →
 *     `listId`, else `${listId}.${channelId}`).
 *
 * Override surface (matches the rest of the kit):
 *   1. `--hs-pref-*` / `--hs-switch-*` / `--hs-tab-*` CSS vars
 *   2. `className` + per-slot `classNames`
 *   3. `data-*` state (root `data-loading`/`data-empty`/`data-matrix`/
 *      `data-sectioned`; section `data-section="channels|topics"`; row
 *      `data-list-id` + `data-kind`; switch `data-state="on|off"`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. `renderRow` / `renderControl` / `renderEmpty` render-prop escapes
 *
 * Closed loop: `setPreference`/`setUnsubscribedAll` already emit
 * `inapp.preference_changed` in the SDK store mutation — do NOT add a capture
 * here.
 */

import { ALL_EMAILS_CATEGORY, type ListSummary } from "@hogsend/js";
import type { ReactNode } from "react";
import { usePreferences } from "../../hooks/use-preferences.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Slot } from "../primitives/slot.js";

/** A channel column in the preference matrix. */
export interface PreferenceChannel {
  id: string;
  label: string;
  /** The primary channel toggles the bare `listId` category (default mapping). */
  primary?: boolean;
}

/** Per-slot class overrides for {@link PreferenceCenter}. */
export interface PreferenceCenterClassNames {
  root?: string;
  header?: string;
  section?: string;
  sectionHeader?: string;
  row?: string;
  rowLabel?: string;
  rowDescription?: string;
  control?: string;
  switch?: string;
  switchThumb?: string;
  cell?: string;
  matrixHeader?: string;
  loading?: string;
  empty?: string;
}

/** Props for {@link PreferenceCenter}. */
export interface PreferenceCenterProps {
  /** Channel columns → renders a category×channel matrix. Omit → single column. */
  channels?: PreferenceChannel[];
  /**
   * Map `(listId, channelId)` → the engine categoryId to toggle. Default:
   * `primary` channel → `listId`, else `${listId}.${channelId}`.
   */
  resolveCategoryId?: (listId: string, channelId: string) => string;
  title?: string;
  /**
   * `"auto"` (default): section Channels/Topics when the catalog carries
   * `kind: "channel"` lists and no `channels` matrix prop is set. `"flat"`:
   * force the legacy single column.
   */
  layout?: "auto" | "flat";
  /**
   * The synthetic email master row in the Channels section (wired to
   * `unsubscribedAll`). Default `{ label: "Email" }`. Pass `false` to hide.
   * Rendered only in sectioned mode. It intentionally BYPASSES `renderRow`
   * (no real `ListSummary` backs it), but its control still flows through
   * `renderControl` with `categoryId: "$all"`.
   */
  emailToggle?: false | { label?: string; description?: string };
  /** Section heading text. Default `{ channels: "Channels", topics: "Topics" }`. */
  sectionLabels?: { channels?: string; topics?: string };
  /** Merge props onto a consumer element (override layer 4). */
  asChild?: boolean;
  className?: string;
  classNames?: PreferenceCenterClassNames;
  /** Replace a whole row (override layer 5). */
  renderRow?: (state: {
    list: ListSummary;
    channels?: PreferenceChannel[];
    toggle: (categoryId: string, next: boolean) => void;
    isOn: (categoryId: string) => boolean;
  }) => ReactNode;
  /** Replace a single matrix cell / the switch (override layer 5). */
  renderControl?: (state: {
    categoryId: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
  }) => ReactNode;
  /** Replace the empty state (override layer 5). */
  renderEmpty?: () => ReactNode;
  /** Fired AFTER the toggle is dispatched (the consumer hook). */
  onPreferenceChange?: (categoryId: string, subscribed: boolean) => void;
  "aria-label"?: string;
}

/** In-house keyboard-native switch — `<button role="switch">`, no Radix. */
function PrefSwitch(props: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  className?: string;
  thumbClassName?: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      data-state={props.checked ? "on" : "off"}
      className={cn("hsr-pref-switch", props.className)}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className={cn("hsr-pref-switch__thumb", props.thumbClassName)} />
    </button>
  );
}

export function PreferenceCenter(props: PreferenceCenterProps): ReactNode {
  const {
    channels,
    resolveCategoryId,
    title,
    layout = "auto",
    emailToggle,
    sectionLabels,
    asChild = false,
    className,
    classNames,
    renderRow,
    renderControl,
    renderEmpty,
    onPreferenceChange,
    "aria-label": ariaLabel,
  } = props;

  const { lists, loading, preferences, setPreference, setUnsubscribedAll } =
    usePreferences();

  // Default category mapping: a `primary` channel toggles the bare `listId`
  // category; every other channel gets its own `${listId}.${channelId}` key.
  const resolve =
    resolveCategoryId ??
    ((listId: string, channelId: string): string => {
      const channel = channels?.find((c) => c.id === channelId);
      return channel?.primary ? listId : `${listId}.${channelId}`;
    });

  // One dispatch for every toggle (a matrix cell or a single switch): run the
  // write (defaulting to `setPreference`, overridable for the synthetic email
  // master row), then fire the consumer hook. `write` receives the SAME `next`
  // the switch reports so a custom writer can re-map it (the email row inverts
  // it into `setUnsubscribedAll`).
  const dispatch = (
    categoryId: string,
    next: boolean,
    write?: (next: boolean) => void,
  ): void => {
    if (write) write(next);
    else void setPreference(categoryId, next);
    onPreferenceChange?.(categoryId, next);
  };

  const isMatrix = Boolean(channels && channels.length > 0);
  const isEmpty = !loading && lists.length === 0;

  // Channel vs topic split (undefined kind → topic). Only channel-kind lists
  // trigger sectioning; an OLD engine emits no kinds → `channelLists` empty →
  // `isSectioned` false → the exact legacy flat body. Matrix mode wins.
  const channelLists = lists.filter((l) => l.kind === "channel");
  const topicLists = lists.filter((l) => l.kind !== "channel");
  const isSectioned = !isMatrix && layout !== "flat" && channelLists.length > 0;

  const stateAttrs = dataVariants({
    loading,
    empty: isEmpty,
    matrix: isMatrix,
    sectioned: isSectioned,
  });

  function renderControlNode(
    categoryId: string,
    checked: boolean,
    label: string,
    write?: (next: boolean) => void,
  ): ReactNode {
    const onChange = (next: boolean): void => dispatch(categoryId, next, write);
    if (renderControl) {
      return renderControl({ categoryId, checked, onChange, label });
    }
    return (
      <PrefSwitch
        checked={checked}
        label={label}
        onChange={onChange}
        {...(classNames?.switch ? { className: classNames.switch } : {})}
        {...(classNames?.switchThumb
          ? { thumbClassName: classNames.switchThumb }
          : {})}
      />
    );
  }

  function renderListRow(list: ListSummary): ReactNode {
    // Row-scoped helpers default the categoryId to THIS list's `defaultOptIn`.
    const isOn = (categoryId: string): boolean =>
      preferences.categories[categoryId] ?? list.defaultOptIn;
    if (renderRow) {
      return (
        <div key={list.id}>
          {renderRow({
            list,
            ...(channels ? { channels } : {}),
            toggle: dispatch,
            isOn,
          })}
        </div>
      );
    }

    const main = (
      <div className="hsr-pref__row-main">
        <div className={cn("hsr-pref__label", classNames?.rowLabel)}>
          {list.name}
        </div>
        {list.description ? (
          <div className={cn("hsr-pref__desc", classNames?.rowDescription)}>
            {list.description}
          </div>
        ) : null}
      </div>
    );

    if (isMatrix && channels) {
      return (
        <div
          key={list.id}
          className={cn("hsr-pref__row", classNames?.row)}
          data-list-id={list.id}
          {...(list.kind ? { "data-kind": list.kind } : {})}
        >
          {main}
          {channels.map((channel) => {
            const categoryId = resolve(list.id, channel.id);
            return (
              <div
                key={channel.id}
                className={cn("hsr-pref__cell", classNames?.cell)}
              >
                {renderControlNode(
                  categoryId,
                  isOn(categoryId),
                  `${list.name} — ${channel.label}`,
                )}
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div
        key={list.id}
        className={cn("hsr-pref__row", classNames?.row)}
        data-list-id={list.id}
        {...(list.kind ? { "data-kind": list.kind } : {})}
      >
        {main}
        <div className={cn("hsr-pref__control", classNames?.control)}>
          {renderControlNode(list.id, isOn(list.id), list.name)}
        </div>
      </div>
    );
  }

  // The synthetic Email master row (sectioned mode only). No real ListSummary
  // backs it, so it BYPASSES renderListRow; its control still flows through
  // renderControlNode with categoryId "$all", but its write inverts `next` into
  // `setUnsubscribedAll` (subscribed-to-email === NOT unsubscribedAll).
  const emailLabel =
    (emailToggle === false ? undefined : emailToggle?.label) ?? "Email";
  const emailDescription =
    emailToggle === false ? undefined : emailToggle?.description;
  // Built ONLY when it will actually render (sectioned mode, master not hidden),
  // so a consumer `renderControl` is never invoked with the "$all" categoryId
  // in flat/matrix mode where the email row is absent.
  const emailRow =
    isSectioned && emailToggle !== false ? (
      <div
        key="$email"
        className={cn("hsr-pref__row", classNames?.row)}
        data-list-id="$email"
        data-kind="channel"
      >
        <div className="hsr-pref__row-main">
          <div className={cn("hsr-pref__label", classNames?.rowLabel)}>
            {emailLabel}
          </div>
          {emailDescription ? (
            <div className={cn("hsr-pref__desc", classNames?.rowDescription)}>
              {emailDescription}
            </div>
          ) : null}
        </div>
        <div className={cn("hsr-pref__control", classNames?.control)}>
          {renderControlNode(
            ALL_EMAILS_CATEGORY,
            !preferences.unsubscribedAll,
            emailLabel,
            (next) => void setUnsubscribedAll(!next),
          )}
        </div>
      </div>
    ) : null;

  const body = loading ? (
    <div className={cn("hsr-pref__loading", classNames?.loading)} role="status">
      Loading…
    </div>
  ) : isEmpty ? (
    renderEmpty ? (
      renderEmpty()
    ) : (
      <div className={cn("hsr-pref__empty", classNames?.empty)}>
        No preferences to manage.
      </div>
    )
  ) : isSectioned ? (
    <>
      <section
        className={cn("hsr-pref__section", classNames?.section)}
        data-section="channels"
      >
        <div
          className={cn("hsr-pref__section-header", classNames?.sectionHeader)}
        >
          {sectionLabels?.channels ?? "Channels"}
        </div>
        {emailRow}
        {channelLists.map((list) => renderListRow(list))}
      </section>
      {topicLists.length > 0 ? (
        <section
          className={cn("hsr-pref__section", classNames?.section)}
          data-section="topics"
        >
          <div
            className={cn(
              "hsr-pref__section-header",
              classNames?.sectionHeader,
            )}
          >
            {sectionLabels?.topics ?? "Topics"}
          </div>
          {topicLists.map((list) => renderListRow(list))}
        </section>
      ) : null}
    </>
  ) : (
    <>
      {isMatrix && channels ? (
        <div
          className={cn("hsr-pref__matrix-header", classNames?.matrixHeader)}
        >
          <div className="hsr-pref__matrix-header-label" />
          {channels.map((channel) => (
            <div key={channel.id} className="hsr-pref__matrix-header-cell">
              {channel.label}
            </div>
          ))}
        </div>
      ) : null}
      {lists.map((list) => renderListRow(list))}
    </>
  );

  const content = (
    <>
      {title ? (
        <div className={cn("hsr-pref__header", classNames?.header)}>
          {title}
        </div>
      ) : null}
      {body}
    </>
  );

  const sharedProps = {
    ...stateAttrs,
    className: cn("hsr", "hsr-pref", className, classNames?.root),
    role: "region",
    "aria-label": ariaLabel ?? title ?? "Notification preferences",
  } as const;

  if (asChild) {
    return <Slot {...sharedProps}>{content as ReactNode}</Slot>;
  }

  return <div {...sharedProps}>{content}</div>;
}
