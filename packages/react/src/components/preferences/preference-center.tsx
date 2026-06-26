"use client";

/**
 * `<PreferenceCenter>` — the list/category opt-in surface, over
 * {@link usePreferences}. Usable standalone OR bundled as a tab inside
 * `<FeedPopover preferences>` (the Novu `<Inbox/>` pattern).
 *
 * Two layouts from one component:
 *   - default (no `channels`): one row per list with a single on/off switch
 *     driving `setPreference(list.id, next)`.
 *   - matrix (`channels` supplied): a category×channel grid. The backend stays a
 *     FLAT `categories` map (migration-free) — per-channel is realized by
 *     distinct category ids via `resolveCategoryId(listId, channelId)` (default:
 *     a `primary` channel → `listId`, else `${listId}.${channelId}`).
 *
 * Override surface (matches the rest of the kit):
 *   1. `--hs-pref-*` / `--hs-switch-*` / `--hs-tab-*` CSS vars
 *   2. `className` + per-slot `classNames`
 *   3. `data-*` state (root `data-loading`/`data-empty`/`data-matrix`; row
 *      `data-list-id`; switch `data-state="on|off"`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. `renderRow` / `renderControl` / `renderEmpty` render-prop escapes
 *
 * Closed loop: `setPreference` already emits `inapp.preference_changed` in the
 * SDK store mutation — do NOT add a capture here.
 */

import type { ListSummary } from "@hogsend/js";
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
    asChild = false,
    className,
    classNames,
    renderRow,
    renderControl,
    renderEmpty,
    onPreferenceChange,
    "aria-label": ariaLabel,
  } = props;

  const { lists, loading, preferences, setPreference } = usePreferences();

  // Default category mapping: a `primary` channel toggles the bare `listId`
  // category; every other channel gets its own `${listId}.${channelId}` key.
  const resolve =
    resolveCategoryId ??
    ((listId: string, channelId: string): string => {
      const channel = channels?.find((c) => c.id === channelId);
      return channel?.primary ? listId : `${listId}.${channelId}`;
    });

  // One dispatch for every toggle (a matrix cell or a single switch): write the
  // preference, then fire the consumer hook.
  const dispatch = (categoryId: string, next: boolean): void => {
    void setPreference(categoryId, next);
    onPreferenceChange?.(categoryId, next);
  };

  const isMatrix = Boolean(channels && channels.length > 0);
  const isEmpty = !loading && lists.length === 0;

  const stateAttrs = dataVariants({
    loading,
    empty: isEmpty,
    matrix: isMatrix,
  });

  function renderControlNode(
    categoryId: string,
    checked: boolean,
    label: string,
  ): ReactNode {
    const onChange = (next: boolean): void => dispatch(categoryId, next);
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
      >
        {main}
        <div className={cn("hsr-pref__control", classNames?.control)}>
          {renderControlNode(list.id, isOn(list.id), list.name)}
        </div>
      </div>
    );
  }

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
