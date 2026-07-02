"use client";

import confetti from "canvas-confetti";

/** The course's celebration burst (quiz finale, chapter completion). */
export function celebrate() {
  const bursts = [
    { particleCount: 90, spread: 70, origin: { y: 0.7 } },
    { particleCount: 60, spread: 110, origin: { y: 0.65 } },
  ];
  for (const burst of bursts) {
    confetti({
      ...burst,
      colors: ["#f64838", "#54d6c4", "#e8b23a", "#ffffff"],
      disableForReducedMotion: true,
    });
  }
}

/** Bigger, double-wave burst for course-level milestones. */
export function celebrateBig() {
  celebrate();
  setTimeout(() => {
    confetti({
      particleCount: 140,
      spread: 160,
      origin: { y: 0.55 },
      colors: ["#f64838", "#54d6c4", "#e8b23a", "#ffffff"],
      disableForReducedMotion: true,
    });
  }, 350);
}
