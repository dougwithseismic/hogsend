"use client";

import { useEffect, useRef } from "react";

/**
 * Auto-continues a purchase the reader began before signing in. Rendered by
 * <Paywall> only when the return path carries a `checkout` marker and the now
 * signed-in reader still lacks access. On mount it submits the same POST to
 * /api/checkout the buy button would — no new authorization surface; the route
 * re-derives everything from the session. A visible button remains below as the
 * manual fallback if the browser blocks the programmatic submit.
 */
export function CheckoutResume({
  course,
  next,
}: {
  course: string;
  next: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return; // guard StrictMode's double-invoke
    submitted.current = true;
    formRef.current?.submit();
  }, []);

  return (
    <form ref={formRef} method="post" action="/api/checkout" className="hidden">
      <input type="hidden" name="course" value={course} />
      <input type="hidden" name="next" value={next} />
    </form>
  );
}
