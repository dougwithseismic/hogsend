export type CampaignShotKind =
  | "impact"
  | "prompt"
  | "proof"
  | "product"
  | "stack"
  | "cta";

export type ProductAsset =
  | "overview"
  | "journeys"
  | "contacts"
  | "campaigns"
  | "sends";

export type ProductFocus = {
  x: number;
  y: number;
  zoom: number;
};

export type CampaignShot = {
  id: string;
  kind: CampaignShotKind;
  from: number;
  to: number;
  copy: string;
  asset?: ProductAsset;
  focus?: ProductFocus;
};

export const CAMPAIGN_SHOTS = [
  { id: "stop", kind: "impact", from: 0, to: 12, copy: "STOP." },
  { id: "chasing", kind: "impact", from: 12, to: 32, copy: "CHASING" },
  {
    id: "customers",
    kind: "impact",
    from: 32,
    to: 54,
    copy: "CUSTOMERS",
  },
  {
    id: "by-hand",
    kind: "product",
    from: 54,
    to: 76,
    copy: "BY HAND.",
    asset: "campaigns",
    focus: { x: 70, y: 28, zoom: 1.35 },
  },
  {
    id: "tell-codex",
    kind: "impact",
    from: 76,
    to: 96,
    copy: "TELL CODEX",
  },
  {
    id: "prompt",
    kind: "prompt",
    from: 96,
    to: 122,
    copy: "what should happen",
  },
  {
    id: "builds",
    kind: "proof",
    from: 122,
    to: 148,
    copy: "BUILDS.",
  },
  {
    id: "tests",
    kind: "proof",
    from: 148,
    to: 174,
    copy: "TESTS.",
  },
  {
    id: "journeys",
    kind: "product",
    from: 174,
    to: 204,
    copy: "Journeys",
    asset: "journeys",
    focus: { x: 55, y: 46, zoom: 1.18 },
  },
  {
    id: "people",
    kind: "product",
    from: 204,
    to: 232,
    copy: "The right people",
    asset: "contacts",
    focus: { x: 28, y: 58, zoom: 1.28 },
  },
  {
    id: "message",
    kind: "product",
    from: 232,
    to: 260,
    copy: "The right message",
    asset: "campaigns",
    focus: { x: 72, y: 32, zoom: 1.3 },
  },
  {
    id: "ships",
    kind: "product",
    from: 260,
    to: 290,
    copy: "SHIPS.",
    asset: "sends",
    focus: { x: 68, y: 40, zoom: 1.24 },
  },
  {
    id: "your-marketing",
    kind: "product",
    from: 290,
    to: 314,
    copy: "YOUR MARKETING.",
    asset: "overview",
    focus: { x: 50, y: 45, zoom: 1.18 },
  },
  {
    id: "your-product",
    kind: "product",
    from: 314,
    to: 338,
    copy: "YOUR PRODUCT.",
    asset: "journeys",
    focus: { x: 42, y: 52, zoom: 1.32 },
  },
  {
    id: "one-system",
    kind: "product",
    from: 338,
    to: 364,
    copy: "ONE SYSTEM.",
    asset: "campaigns",
    focus: { x: 55, y: 48, zoom: 1.42 },
  },
  {
    id: "built-together",
    kind: "stack",
    from: 364,
    to: 392,
    copy: "BUILT TOGETHER.",
  },
  {
    id: "promise",
    kind: "impact",
    from: 392,
    to: 420,
    copy: "Customer marketing, built in.",
  },
  { id: "cta", kind: "cta", from: 420, to: 450, copy: "hogsend.com" },
] as const satisfies readonly CampaignShot[];

export const getCampaignShot = (frame: number): CampaignShot => {
  const boundedFrame = Math.max(0, Math.min(449, frame));
  const fallback = CAMPAIGN_SHOTS.at(-1);
  if (!fallback) throw new Error("Kinetic campaign needs at least one shot.");
  return (
    CAMPAIGN_SHOTS.find(
      ({ from, to }) => boundedFrame >= from && boundedFrame < to,
    ) ?? fallback
  );
};
