/**
 * The progressive-profiling registry: every `<CheckIn id="…">` block in the
 * course content maps here to the Hogsend contact property its answer is
 * written to. The API validates the id against this map (unknown ids 400), so
 * content can't invent contact properties; the OPTIONS a check-in offers live
 * in the MDX, not here, so lessons can rephrase choices without code changes.
 */

export type ProfileField = {
  /** Hogsend contact property the answer lands on (camelCase, profile-prefixed). */
  contactProperty: string;
};

export const PROFILE_FIELDS: Record<string, ProfileField> = {
  /** Who they are. */
  role: { contactProperty: "profileRole" },
  stage: { contactProperty: "profileStage" },
  productType: { contactProperty: "profileProductType" },
  /** Their current stack + habits. */
  analyticsStack: { contactProperty: "profileAnalyticsStack" },
  dataHabit: { contactProperty: "profileDataHabit" },
  messagingStack: { contactProperty: "profileMessagingStack" },
  abTesting: { contactProperty: "profileAbTesting" },
  /** What's working and what isn't. */
  biggestLeak: { contactProperty: "profileBiggestLeak" },
  whatsWorking: { contactProperty: "profileWhatsWorking" },
  acquisitionMix: { contactProperty: "profileAcquisitionMix" },
  community: { contactProperty: "profileCommunity" },
  biggestNeed: { contactProperty: "profileBiggestNeed" },
  /** Commitment at the end of the course. */
  planCommitment: { contactProperty: "profilePlanCommitment" },
};

/** Input caps shared by the responses API and the client components. */
export const PROFILE_LIMITS = {
  maxChoices: 8,
  maxChoiceLength: 120,
  maxNoteLength: 500,
} as const;
