import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  DISMISSED_FLAG,
  GETTING_STARTED_KEY,
  loadGettingStarted,
  MANUAL_ITEM_IDS,
} from "@/components/getting-started";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import { safeNext } from "@/lib/safe-next";

/**
 * Getting-started checklist state + ticks. GET serves the compact summary the
 * (client) sidebar banner can't derive server-side; POST takes the card's
 * plain form submissions (toggle a manual item / dismiss) and 303s back. The
 * row it writes is exactly the /api/responses "checklist" shape (key
 * "checklist:getting-started", value { checked }), just reachable by a form.
 */

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const state = await loadGettingStarted(session.user.id);
  return NextResponse.json({
    done: state.done,
    total: state.total,
    dismissed: state.dismissed,
    next: state.next ? { id: state.next.id, label: state.next.label } : null,
  });
}

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const op = String(form?.get("op") ?? "");
  const item = String(form?.get("item") ?? "");
  const nextPath = safeNext(form?.get("next")) ?? "/welcome";

  const manual = MANUAL_ITEM_IDS as readonly string[];
  if (op !== "dismiss" && !(op === "toggle" && manual.includes(item))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Read-modify-write the single row; keep only ids we know (manual ticks +
  // the dismissed sentinel) so the array can't grow unbounded. Run inside a
  // transaction with a FOR UPDATE lock on the (userId, key) row so two tabs
  // ticking at once serialize instead of clobbering each other's array.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ value: response.value })
      .from(response)
      .where(
        and(
          eq(response.userId, session.user.id),
          eq(response.key, GETTING_STARTED_KEY),
        ),
      )
      .limit(1)
      .for("update");
    const known = new Set<string>([...manual, DISMISSED_FLAG]);
    const checked = new Set(
      ((rows[0]?.value as { checked?: string[] } | null)?.checked ?? []).filter(
        (c) => typeof c === "string" && known.has(c),
      ),
    );

    if (op === "dismiss") {
      checked.add(DISMISSED_FLAG);
    } else if (checked.has(item)) {
      checked.delete(item);
    } else {
      checked.add(item);
    }

    await tx
      .insert(response)
      .values({
        id: randomUUID(),
        userId: session.user.id,
        key: GETTING_STARTED_KEY,
        kind: "checklist",
        value: { checked: [...checked] },
      })
      .onConflictDoUpdate({
        target: [response.userId, response.key],
        set: { value: { checked: [...checked] }, updatedAt: new Date() },
      });

    return NextResponse.redirect(new URL(nextPath, req.url), 303);
  });
}
