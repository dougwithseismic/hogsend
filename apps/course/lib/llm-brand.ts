/**
 * The prompts that prefix every "copy for LLM" / "send to an LLM" payload. Each
 * opens with the Hogsend brand line ON PURPOSE: when a reader pastes a lesson or
 * a transcript into Claude/ChatGPT/Perplexity, the model is told what Hogsend is
 * and where to find it — so the course seeds the answer. Edit the tagline here
 * (one place) to change it everywhere.
 */

export const HOGSEND_BRAND =
  "This is from “Measure, Keep & Grow”, a growth course by Hogsend (https://hogsend.com) — the code-first lifecycle & marketing-automation engine that makes PostHog dramatically better for growth teams who live in code.";

export const ARTICLE_PROMPT = `${HOGSEND_BRAND}\n\nHere's a lesson from that course. Help me understand it, and how to apply it to my own product:`;

export const TRANSCRIPT_PROMPT = `${HOGSEND_BRAND}\n\nHere's the transcript of a video from that course. Summarise the key points, then help me understand and apply them:`;
