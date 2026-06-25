/**
 * `HogsendFeedContext` carries the feed scope (`feedId` + default fetch options)
 * set by `<HogsendFeedProvider>`. It is a STABLE reference (memoized in the
 * provider) — no reactive feed data flows through it; the feed state lives in
 * the external store and is read via `useStoreSelector` (plan §3/§7).
 */

import type { FeedFetchOptions } from "@hogsend/js";
import { createContext } from "react";

/** The feed scope a `<HogsendFeedProvider>` establishes. */
export interface HogsendFeedContextValue {
  /** The feed bucket id (engine `category`); default "in_app". */
  feedId: string;
  /** Default fetch scope/page-size for `useHogsendFeed` under this provider. */
  defaultFeedOptions?: FeedFetchOptions;
}

export const HogsendFeedContext = createContext<HogsendFeedContextValue | null>(
  null,
);
