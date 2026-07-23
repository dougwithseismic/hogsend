import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOPILOT_ANSWERS,
  activeEventLines,
  autopilotKey,
  buildEvents,
  completeDemo,
  type DemoEvent,
  type DemoState,
  finalEventLines,
  INITIAL_DEMO_STATE,
  keyDemo,
  type Line,
  tickDemo,
} from "./cli-scaffold-demo-state.ts";

const VERSION = "0.52.1";

const plain = (line: Line): string => line.map((s) => s.text).join("");
const flatten = (events: DemoEvent[], answers = AUTOPILOT_ANSWERS): string =>
  events
    .flatMap((e) => finalEventLines(e, answers))
    .map(plain)
    .join("\n");

/** Drive the machine to the end: ticks for time events, autopilot for prompts. */
function runToCompletion(start: DemoState): DemoState {
  let state = start;
  for (let i = 0; i < 5000 && !state.done; i++) {
    const events = buildEvents(state.answers, VERSION);
    const event = events[state.eventIndex];
    if (event.kind === "prompt") {
      const key = autopilotKey(state, events);
      assert.ok(key, "autopilot must always have a next key on a prompt");
      state = keyDemo(state, events, key, VERSION);
    } else {
      state = tickDemo(state, events);
    }
  }
  assert.ok(state.done, "the demo must reach the end");
  return state;
}

test("autopilot drives the full run to the outro with the default answers", () => {
  const state = runToCompletion(INITIAL_DEMO_STATE);
  assert.equal(state.answers.name, "acme-lifecycle");
  assert.equal(state.answers.domain, "acme.com");
  assert.equal(state.answers.posthog, true);

  const transcript = flatten(
    buildEvents(state.answers, VERSION),
    state.answers,
  );
  // the real clack session, in order
  assert.match(transcript, /❯ pnpm create hogsend@latest/);
  assert.match(
    transcript,
    / create-hogsend .*v0\.52\.1 · scaffold a Hogsend app/,
  );
  assert.match(transcript, /Welcome to Hogsend ─+╮/);
  assert.match(
    transcript,
    /◇ {2}Project name\? \(or "\." for the current folder\)/,
  );
  assert.match(transcript, /│ {2}acme-lifecycle/);
  assert.match(transcript, /◇ {2}Where will events come from\?/);
  assert.match(transcript, /│ {2}My app code, PostHog/);
  assert.match(transcript, /✓ Scaffolded acme-lifecycle/);
  assert.match(transcript, /EMAIL_FROM=hello@acme\.com/);
  assert.match(transcript, /✓ Git repo initialized/);
  assert.match(transcript, /✓ Dependencies installed/);
  // bootstrap streams with the PostHog step making it 9
  assert.match(transcript, /\[1\/9\] Checking Docker/);
  assert.match(transcript, /\[9\/9\] Connecting PostHog \(optional\)/);
  assert.match(transcript, /✓ Ready\. Welcome to Hogsend\./);
  assert.match(transcript, /└ {2}Welcome to Hogsend\./);
});

test("skipping install drops the setup prompt and moves bootstrap to Next steps", () => {
  let state = INITIAL_DEMO_STATE;
  // walk up to the install confirm, then answer No
  for (let i = 0; i < 5000; i++) {
    const events = buildEvents(state.answers, VERSION);
    const event = events[state.eventIndex];
    if (event.kind === "prompt" && event.prompt.id === "install") break;
    if (event.kind === "prompt") {
      const key = autopilotKey(state, events);
      assert.ok(key);
      state = keyDemo(state, events, key, VERSION);
    } else {
      state = tickDemo(state, events);
    }
  }
  let events = buildEvents(state.answers, VERSION);
  state = keyDemo(state, events, { type: "space" }, VERSION); // flip to No
  events = buildEvents(state.answers, VERSION);
  state = keyDemo(state, events, { type: "enter" }, VERSION);

  state = runToCompletion(state);
  assert.equal(state.answers.install, false);
  const transcript = flatten(
    buildEvents(state.answers, VERSION),
    state.answers,
  );
  assert.doesNotMatch(transcript, /Set up local infra now\?/);
  assert.doesNotMatch(transcript, /✓ Dependencies installed/);
  assert.doesNotMatch(transcript, /\[1\/\d\] Checking Docker/);
  assert.match(transcript, /Next steps ─+╮/);
  assert.match(transcript, /pnpm install/);
  assert.match(transcript, /pnpm bootstrap {3}# Docker infra/);
});

test("leaving PostHog unticked yields an 8-step bootstrap and no connect step", () => {
  const answers = { ...AUTOPILOT_ANSWERS, posthog: false };
  const transcript = flatten(buildEvents(answers, VERSION), answers);
  assert.match(transcript, /\[8\/8\] Creating your first Studio admin/);
  assert.doesNotMatch(transcript, /Connecting PostHog/);
  assert.doesNotMatch(transcript, /No PostHog key needed/);
});

test("answering y to the Studio admin question adds the real CLI's admin prompts", () => {
  const answers = { ...AUTOPILOT_ANSWERS, createAdmin: true };
  const events = buildEvents(answers, VERSION);
  const prompts = events
    .filter((e) => e.kind === "prompt")
    .map((e) => (e.kind === "prompt" ? e.prompt.id : ""));
  assert.deepEqual(prompts.slice(prompts.indexOf("createAdmin")), [
    "createAdmin",
    "adminEmail",
    "adminPassword",
    "adminConfirm",
    "connectPosthog",
  ]);
  const transcript = flatten(events, answers);
  assert.match(transcript, /Admin email/);
  assert.match(transcript, /New password \(min 8 chars\)/);
  assert.match(transcript, /✓ Studio admin created/);
  // passwords render masked, never in clear text
  assert.doesNotMatch(transcript, new RegExp(answers.adminPassword));
  assert.match(transcript, /▪+/);
});

test("note boxes stay square — every row the same plain width", () => {
  const events = buildEvents({ ...AUTOPILOT_ANSWERS, setup: false }, VERSION);
  for (const event of events) {
    if (event.kind !== "lines") continue;
    const rows = event.lines.map(plain);
    const top = rows.find((r) => r.includes("╮"));
    if (!top) continue;
    const bottom = rows.find((r) => r.includes("╯"));
    assert.ok(bottom);
    const body = rows.filter(
      (r) => r.length > 1 && r.startsWith("│") && r.endsWith("│"),
    );
    assert.ok(body.length >= 3, "a note box has padded body rows");
    for (const row of [top, bottom, ...body])
      assert.equal(row.length, top.length, `box row drifted: "${row}"`);
  }
});

test("typing into the name prompt echoes and reshapes the scaffold line", () => {
  let state = INITIAL_DEMO_STATE;
  for (let i = 0; i < 500; i++) {
    const events = buildEvents(state.answers, VERSION);
    const event = events[state.eventIndex];
    if (event.kind === "prompt" && event.prompt.id === "name") break;
    state = tickDemo(state, events);
  }
  let events = buildEvents(state.answers, VERSION);
  for (const ch of "rocket-mail")
    state = keyDemo(state, events, { type: "char", ch }, VERSION);
  const active = activeEventLines(state, events).map(plain).join("\n");
  assert.match(active, /◆ {2}Project name\?/);
  assert.match(active, /rocket-mail/);
  state = keyDemo(state, events, { type: "enter" }, VERSION);
  assert.equal(state.answers.name, "rocket-mail");
  events = buildEvents(state.answers, VERSION);
  const transcript = flatten(events, state.answers);
  assert.match(transcript, /✓ Scaffolded rocket-mail/);
  assert.match(transcript, /cd rocket-mail · docs\.hogsend\.com/);
});

test("completeDemo lands on the same transcript as an autopiloted run", () => {
  const finished = runToCompletion(INITIAL_DEMO_STATE);
  const jumped = completeDemo(VERSION);
  assert.equal(
    flatten(buildEvents(finished.answers, VERSION), finished.answers),
    flatten(jumped.events, jumped.state.answers),
  );
  assert.ok(jumped.state.done);
});
