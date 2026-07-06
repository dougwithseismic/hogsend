"use client";

import { PreferenceCenter } from "@hogsend/react";
import type { JSX } from "react";
import {
  CourseHogsendProvider,
  isHogsendConfigured,
} from "@/components/hogsend/provider";

/**
 * The account page's email-preference matrix — the same Hogsend preference
 * center the links in our emails open, embedded in-app. Writes ride the
 * signed-in reader's server-minted userToken (CourseHogsendProvider), so a
 * toggle here IS the contact's preference, immediately, no email link needed.
 */
export function CommunicationsSection(): JSX.Element | null {
  if (!isHogsendConfigured) return null;
  return (
    <CourseHogsendProvider>
      <PreferenceCenter
        aria-label="Email preferences"
        renderEmpty={() => (
          <p className="text-sm text-white/50 leading-6">
            No mailing lists are live right now. When one launches, you can opt
            in or out here — and from the link in every email.
          </p>
        )}
      />
    </CourseHogsendProvider>
  );
}
