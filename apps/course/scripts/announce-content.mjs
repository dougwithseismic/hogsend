// Announce NEW course content to the readers who haven't seen it: for every
// enrolled-or-purchased user WITHOUT lesson_progress on the new lesson, emit
// a per-user course.content_published event into the Hogsend ingest — the
// dogfood courseNewContent journey turns those into "new chapter" emails.
// Idempotent per user×lesson (stable Idempotency-Key), so re-running after a
// partial failure only fills the gaps.
//
// Usage:
//   DATABASE_URL=… HOGSEND_INGEST_URL=… HOGSEND_INGEST_KEY=… \
//     node scripts/announce-content.mjs \
//       --course growth-with-posthog \
//       --lesson 11-shipping-your-plan \
//       --title "Chapter 11 — Shipping your plan" [--dry-run]
import postgres from "postgres";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : "";
}
const course = flag("course");
const lesson = flag("lesson");
const title = flag("title");
const dryRun = args.includes("--dry-run");

if (!course || !lesson || !title) {
  console.error(
    "usage: node scripts/announce-content.mjs --course <slug> --lesson <slug> --title <text> [--dry-run]",
  );
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const ingestUrl = process.env.HOGSEND_INGEST_URL;
const ingestKey = process.env.HOGSEND_INGEST_KEY;
if (!dryRun && (!ingestUrl || !ingestKey)) {
  console.error("HOGSEND_INGEST_URL / HOGSEND_INGEST_KEY are not set");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL);

// Everyone with a stake in the course (enrolled OR paid — a purchaser who
// hasn't opened a gated lesson yet has no enrollment row), minus anyone who
// already completed the new lesson.
const targets = await sql`
  SELECT DISTINCT u.id, u.email, u.name
  FROM "user" u
  WHERE (
    u.id IN (SELECT user_id FROM enrollment WHERE course_slug = ${course})
    OR u.id IN (
      SELECT user_id FROM purchase
      WHERE course_slug IN (${course}, 'all-access') AND status = 'paid'
    )
  )
  AND u.id NOT IN (
    SELECT user_id FROM lesson_progress
    WHERE course_slug = ${course} AND lesson_slug = ${lesson}
  )
  ORDER BY u.email
`;
await sql.end();

const url = `https://course.hogsend.com/learn/${course}/${lesson}`;
console.log(
  `${dryRun ? "[dry-run] " : ""}${targets.length} reader(s) to announce "${title}" to`,
);
if (dryRun) {
  for (const t of targets.slice(0, 5)) console.log(`  ${t.email}`);
  if (targets.length > 5) console.log(`  … and ${targets.length - 5} more`);
  process.exit(0);
}

let sent = 0;
let failed = 0;
for (const target of targets) {
  const body = {
    name: "course.content_published",
    email: target.email,
    contactProperties: { courseUserId: target.id },
    eventProperties: {
      source: "course-site",
      course,
      lesson,
      lessonTitle: title,
      url,
    },
  };
  try {
    const res = await fetch(`${ingestUrl.replace(/\/+$/, "")}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestKey}`,
        "Idempotency-Key": `course-content-${course}-${lesson}-${target.id}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) sent++;
    else {
      failed++;
      console.error(`  ${target.email}: HTTP ${res.status}`);
    }
  } catch (err) {
    failed++;
    console.error(`  ${target.email}: ${err}`);
  }
}
console.log(`sent ${sent}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
