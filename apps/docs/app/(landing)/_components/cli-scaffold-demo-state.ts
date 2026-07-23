/**
 * State machine for the interactive create-hogsend replay on the homepage.
 *
 * Every string, glyph and color below is transcribed from the real scaffolder
 * (packages/create-hogsend) and the bootstrap script it streams
 * (template/scripts/bootstrap.ts), captured frame-by-frame from an actual
 * @clack/prompts 1.5 session — ◆ cyan while active, ◇ green once submitted,
 * the gray │ rail, dim answers, magenta spinner dots, the note boxes. The
 * component renders these frames; this module owns what they say and when.
 *
 * Pure module — no timers, no DOM. Tested in cli-scaffold-demo-state.test.mts.
 */

/* ------------------------------------------------------------------ spans -- */

export type Tone =
  | "plain" // white/85 — default foreground
  | "dim" // picocolors dim
  | "gray" // clack's gray rail │
  | "cyan"
  | "green"
  | "yellow"
  | "magenta"
  | "blue"
  | "badge" // bgMagenta + black text (the create-hogsend badge)
  | "cursor"; // inverse-video block over the char under the caret

export type Span = { text: string; tone?: Tone; b?: true };
export type Line = Span[];

const t = (text: string, tone?: Tone, b?: true): Span =>
  b ? { text, tone, b } : { text, tone };
const dim = (s: string): Span => t(s, "dim");
const gray = (s: string): Span => t(s, "gray");
const cyan = (s: string): Span => t(s, "cyan");
const green = (s: string): Span => t(s, "green");

const RAIL: Line = [gray("│")];

const plainLength = (line: Line): number =>
  line.reduce((n, s) => n + s.text.length, 0);

/* ---------------------------------------------------------------- answers -- */

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type ScaffoldAnswers = {
  name: string;
  domain: string; // "" = configure later
  app: boolean;
  posthog: boolean;
  packageManager: PackageManager;
  install: boolean;
  git: boolean;
  skills: boolean;
  setup: boolean;
  // bootstrap step 8/9 (plain readline prompts, not clack)
  createAdmin: boolean;
  adminEmail: string;
  adminPassword: string;
  connectPosthog: boolean;
};

/** What the demo answers on its own when nobody grabs the keyboard. */
export const AUTOPILOT_ANSWERS: ScaffoldAnswers = {
  name: "acme-lifecycle",
  domain: "acme.com",
  app: true,
  posthog: true,
  packageManager: "pnpm",
  install: true,
  git: true,
  skills: true,
  setup: true,
  createAdmin: false,
  adminEmail: "you@acme.com",
  adminPassword: "correct-horse",
  connectPosthog: true,
};

export const INITIAL_ANSWERS: ScaffoldAnswers = {
  ...AUTOPILOT_ANSWERS,
  name: "",
  domain: "",
  posthog: false,
};

/* ---------------------------------------------------------------- prompts -- */

export type PromptSpec =
  | {
      kind: "text";
      id: "name" | "domain" | "adminEmail" | "adminPassword" | "adminConfirm";
      message: string;
      placeholder: string;
      mask?: true;
    }
  | {
      kind: "multiselect";
      id: "sources";
      message: string;
      options: ReadonlyArray<{
        value: "app" | "posthog";
        label: string;
        hint: string;
      }>;
    }
  | {
      kind: "select";
      id: "pm";
      message: string;
      options: readonly PackageManager[];
    }
  | {
      kind: "confirm";
      id: "install" | "git" | "skills" | "setup";
      message: string;
    }
  // bootstrap's dependency-free `question (y/N)` readline confirms
  | {
      kind: "inline";
      id: "createAdmin" | "connectPosthog";
      question: string;
      hint: "y/N" | "Y/n";
    };

export type DemoEvent =
  | { kind: "shell"; command: string }
  | { kind: "lines"; lines: Line[]; speed: "fast" | "step" }
  | { kind: "prompt"; prompt: PromptSpec }
  | {
      kind: "spinner";
      style: "clack" | "braille";
      label: string;
      ticks: number;
      stop: Line[];
    };

export const CLACK_SPINNER_FRAMES = ["◒", "◐", "◓", "◑"] as const;
export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/* -------------------------------------------------- clack line builders -- */

/**
 * A clack note box, sized like the real renderer: two-space content padding,
 * the title riding the top rule. All rows come out the same plain width so the
 * box stays square in a mono font.
 */
function noteBox(title: Span, content: Line[]): Line[] {
  const contentWidth = Math.max(...content.map(plainLength));
  const inner = contentWidth + 4;
  const pad = (line: Line): Line => [
    gray("│"),
    t("  "),
    ...line,
    t(" ".repeat(inner - 4 - plainLength(line) + 2)),
    gray("│"),
  ];
  const blank: Line = [gray("│"), t(" ".repeat(inner)), gray("│")];
  return [
    RAIL,
    [
      green("◇"),
      t("  "),
      title,
      t(" "),
      gray(`${"─".repeat(Math.max(1, inner - title.text.length - 3))}╮`),
    ],
    blank,
    ...content.map(pad),
    blank,
    [gray(`├${"─".repeat(inner)}╯`)],
  ];
}

/** clack log.step — green ◇ line. */
const logStep = (spans: Line): Line[] => [
  RAIL,
  [green("◇"), t("  "), ...spans],
];
/** clack log.info — blue ● line. */
const logInfo = (spans: Line): Line[] => [
  RAIL,
  [t("●", "blue"), t("  "), ...spans],
];

/** The answer a submitted prompt shows on its dim │ line. */
export function submittedAnswer(
  spec: PromptSpec,
  answers: ScaffoldAnswers,
): string {
  switch (spec.kind) {
    case "text": {
      const value =
        answers[spec.id === "adminConfirm" ? "adminPassword" : spec.id];
      return spec.mask ? "▪".repeat(value.length) : value;
    }
    case "multiselect":
      return spec.options
        .filter((o) => answers[o.value])
        .map((o) => o.label)
        .join(", ");
    case "select":
      return answers.packageManager;
    case "confirm":
      return answers[spec.id] ? "Yes" : "No";
    case "inline":
      return "";
  }
}

/** Submitted clack block: green ◇ + message, dim answer on the rail. */
export function submittedPromptLines(
  spec: PromptSpec,
  answers: ScaffoldAnswers,
): Line[] {
  if (spec.kind === "inline") {
    // bootstrap readline echoes the typed answer after the (y/N) hint
    const yes = answers[spec.id];
    const typed = yes === (spec.hint === "Y/n") ? "" : yes ? "y" : "n";
    return [[t(`  ${spec.question} `), dim(`(${spec.hint})`), t(` ${typed}`)]];
  }
  return [
    RAIL,
    [green("◇"), t(`  ${spec.message}`)],
    [gray("│"), t("  "), dim(submittedAnswer(spec, answers))],
  ];
}

/* ------------------------------------------------------------- the script -- */

const DOCS = "docs.hogsend.com";
const DISCORD = "discord.gg/rv6eZNvYrr";
const STUDIO_LOCAL_URL = "http://localhost:3002/studio";

export const PROMPTS: Record<string, PromptSpec> = {
  name: {
    kind: "text",
    id: "name",
    message: 'Project name? (or "." for the current folder)',
    placeholder: "acme-lifecycle",
  },
  domain: {
    kind: "text",
    id: "domain",
    message: "Sending domain? (blank to configure later)",
    placeholder: "mysite.com",
  },
  sources: {
    kind: "multiselect",
    id: "sources",
    message:
      "Where will events come from? (space to toggle — pick all that apply, or none)",
    options: [
      {
        value: "app",
        label: "My app code",
        hint: "@hogsend/client SDK, pre-wired — zero config",
      },
      {
        value: "posthog",
        label: "PostHog",
        hint: "connected at the end of setup (browser OAuth) — no key needed",
      },
    ],
  },
  pm: {
    kind: "select",
    id: "pm",
    message: "Package manager?",
    options: ["pnpm", "npm", "yarn", "bun"],
  },
  install: {
    kind: "confirm",
    id: "install",
    message: "Install dependencies now?",
  },
  git: { kind: "confirm", id: "git", message: "Initialize a git repo?" },
  skills: {
    kind: "confirm",
    id: "skills",
    message: "Include Claude Code skills + a tailored CLAUDE.md? (recommended)",
  },
  setup: {
    kind: "confirm",
    id: "setup",
    message: "Set up local infra now? (Docker, .env, Hatchet token, migrate)",
  },
  createAdmin: {
    kind: "inline",
    id: "createAdmin",
    question: "Create your first Studio admin now?",
    hint: "y/N",
  },
  connectPosthog: {
    kind: "inline",
    id: "connectPosthog",
    question:
      "One last thing — connect PostHog now? (opens your browser to authorize; no keys to paste)",
    hint: "Y/n",
  },
  adminEmail: {
    kind: "text",
    id: "adminEmail",
    message: "Admin email",
    placeholder: "you@acme.com",
  },
  adminPassword: {
    kind: "text",
    id: "adminPassword",
    message: "New password (min 8 chars)",
    placeholder: "",
    mask: true,
  },
  adminConfirm: {
    kind: "text",
    id: "adminConfirm",
    message: "Confirm password",
    placeholder: "",
    mask: true,
  },
};

const stepHeader = (n: number, total: number, label: string): Line[] => [
  [],
  [t(`[${n}/${total}]`, "magenta", true), t(" "), t(label, "plain", true)],
];
const stepOk = (msg: Line): Line[] => [[t("  "), green("✓"), t(" "), ...msg]];
const stepInfo = (msg: string): Line[] => [
  [t("  "), dim("·"), t(" "), dim(msg)],
];

/**
 * The full session for a given set of answers. Answers only shape events that
 * come AFTER the prompt that collects them, so an in-flight index into this
 * list stays valid when an answer changes the tail.
 */
export function buildEvents(
  answers: ScaffoldAnswers,
  version: string,
): DemoEvent[] {
  const a = answers;
  const dir = a.name === "" ? AUTOPILOT_ANSWERS.name : a.name;
  const events: DemoEvent[] = [];

  events.push({ kind: "shell", command: "pnpm create hogsend@latest" });

  events.push({
    kind: "lines",
    speed: "fast",
    lines: [
      [
        gray("┌"),
        t("  "),
        t(" create-hogsend ", "badge"),
        t(" "),
        dim(`v${version} · scaffold a Hogsend app · ${DOCS}`),
      ],
      ...noteBox(t("Welcome to Hogsend", "magenta"), [
        [dim("Lifecycle marketing for scrappy product engineering teams —")],
        [dim("code-first journeys on PostHog + Resend.")],
        [dim("Docs & guides: "), cyan("hogsend.com")],
      ]),
    ],
  });

  events.push({ kind: "prompt", prompt: PROMPTS.name });
  events.push({ kind: "prompt", prompt: PROMPTS.domain });
  events.push({ kind: "prompt", prompt: PROMPTS.sources });
  if (a.posthog) {
    events.push({
      kind: "lines",
      speed: "fast",
      lines: logInfo([
        t(
          "No PostHog key needed. Local setup offers a one-click connect at the end (browser OAuth) — or run `pnpm hogsend connect posthog` from your app folder any time.",
        ),
      ]),
    });
  }
  events.push({ kind: "prompt", prompt: PROMPTS.pm });
  events.push({ kind: "prompt", prompt: PROMPTS.install });
  events.push({ kind: "prompt", prompt: PROMPTS.git });
  events.push({ kind: "prompt", prompt: PROMPTS.skills });
  if (a.install) events.push({ kind: "prompt", prompt: PROMPTS.setup });

  events.push({
    kind: "spinner",
    style: "clack",
    label: `Scaffolding ${dir}`,
    ticks: 7,
    stop: [
      RAIL,
      [green("◇"), t("  "), green("✓"), t(" Scaffolded "), cyan(dir)],
    ],
  });

  if (a.domain !== "") {
    events.push({
      kind: "lines",
      speed: "fast",
      lines: logStep([
        dim("Sending domain —"),
        t(` EMAIL_FROM=hello@${a.domain} `),
        dim("+"),
        t(` EMAIL_DOMAIN=${a.domain}`),
      ]),
    });
  }

  if (a.git) {
    events.push({
      kind: "spinner",
      style: "clack",
      label: "Initializing git repo",
      ticks: 6,
      stop: [
        RAIL,
        [green("◇"), t("  "), green("✓"), t(" Git repo initialized")],
      ],
    });
  }

  if (a.install) {
    events.push({
      kind: "spinner",
      style: "clack",
      label: `Installing dependencies (${a.packageManager} install)`,
      ticks: 16,
      stop: [
        RAIL,
        [green("◇"), t("  "), green("✓"), t(" Dependencies installed")],
      ],
    });
  }

  const runSetup = a.install && a.setup;
  if (runSetup) {
    events.push({
      kind: "lines",
      speed: "fast",
      lines: logStep([dim("Running local setup —"), t(" pnpm bootstrap")]),
    });
    events.push(...bootstrapEvents(a));
  }

  if (!runSetup) {
    const content: Line[] = [[cyan(`cd ${dir}`)]];
    if (!a.install) content.push([cyan(`${a.packageManager} install`)]);
    content.push(
      [
        cyan(`${a.packageManager} bootstrap`),
        dim("   # Docker infra + .env + Hatchet token + migrate"),
      ],
      [
        cyan(`${a.packageManager} hogsend dev`),
        dim("   # API + worker + Studio on :3002, one terminal"),
      ],
      [],
      [
        dim("Studio".padEnd(8)),
        cyan(STUDIO_LOCAL_URL),
        dim("   # dashboard — open it after pnpm hogsend dev"),
      ],
      [
        dim("Docs".padEnd(8)),
        cyan(DOCS),
        dim("   # guides + your first journey: src/journeys/welcome.ts"),
      ],
      [
        dim("Discord".padEnd(8)),
        cyan(DISCORD),
        dim("   # questions, help, and what we're shipping"),
      ],
      [],
      a.skills
        ? [
            dim("Agent skills: "),
            cyan(".claude/skills"),
            dim("   · Claude Code discovers them automatically"),
          ]
        : [
            dim("Add agent skills later: "),
            cyan("pnpm dlx hogsend skills add"),
          ],
    );
    if (a.posthog) {
      content.push([
        cyan("pnpm hogsend connect posthog"),
        dim(
          "  # after deploy: authorize PostHog, mint the webhook secret, wire the event loop",
        ),
      ]);
    }
    events.push({
      kind: "lines",
      speed: "fast",
      lines: noteBox(t("Next steps"), content),
    });
  }

  if (runSetup && a.posthog) {
    events.push({
      kind: "lines",
      speed: "fast",
      lines: logInfo([
        cyan(`cd ${dir} && pnpm hogsend connect posthog`),
        dim(
          "  # after deploy: authorize PostHog, mint the webhook secret, wire the event loop",
        ),
      ]),
    });
  }

  events.push({
    kind: "lines",
    speed: "fast",
    lines: [
      RAIL,
      [
        gray("└"),
        t("  "),
        t("Welcome to Hogsend.", "magenta"),
        t(" "),
        dim(`cd ${dir} · ${DOCS} · ${DISCORD}`),
      ],
    ],
  });

  return events;
}

/** The bootstrap stream — template/scripts/bootstrap.ts, happy path. */
function bootstrapEvents(a: ScaffoldAnswers): DemoEvent[] {
  const total = a.posthog ? 9 : 8;
  const events: DemoEvent[] = [];
  const lines = (ls: Line[]): void => {
    events.push({ kind: "lines", speed: "step", lines: ls });
  };

  lines([
    [],
    [
      t("◆ Hogsend", "magenta", true),
      t(" "),
      dim("local bootstrap"),
      t(" "),
      dim("· docs.hogsend.com"),
    ],
  ]);

  lines([
    ...stepHeader(1, total, "Checking Docker"),
    ...stepOk([t("Docker is running")]),
  ]);
  lines([
    ...stepHeader(2, total, "Preparing .env"),
    ...stepOk([t("Created .env with a fresh BETTER_AUTH_SECRET")]),
  ]);
  lines([
    ...stepHeader(3, total, "Resolving ports"),
    ...stepOk([t("All default ports are free")]),
  ]);

  lines(stepHeader(4, total, "Starting containers"));
  events.push({
    kind: "spinner",
    style: "braille",
    label: "docker compose up -d --wait (first run pulls images — be patient)",
    ticks: 18,
    stop: stepOk([t("Postgres, Redis and Hatchet-Lite are up")]),
  });

  lines(stepHeader(5, total, "Minting Hatchet token"));
  events.push({
    kind: "spinner",
    style: "braille",
    label: "Waiting for Hatchet to finish initializing…",
    ticks: 12,
    stop: stepOk([t("Minted a Hatchet API token → .env")]),
  });

  lines([
    ...stepHeader(6, total, "Running migrations"),
    ...stepOk([t("Database migrated")]),
  ]);
  lines([
    ...stepHeader(7, total, "Minting API keys"),
    ...stepOk([
      t("Minted an ingest-scoped data-plane key → HOGSEND_API_KEY in .env"),
    ]),
  ]);

  lines(stepHeader(8, total, "Creating your first Studio admin"));
  events.push({ kind: "prompt", prompt: PROMPTS.createAdmin });
  if (a.createAdmin) {
    events.push({ kind: "prompt", prompt: PROMPTS.adminEmail });
    events.push({ kind: "prompt", prompt: PROMPTS.adminPassword });
    events.push({ kind: "prompt", prompt: PROMPTS.adminConfirm });
    lines(stepOk([t("Studio admin created")]));
  } else {
    lines(
      stepInfo(
        "Skipped. Create one later: `pnpm studio:admin` (or set STUDIO_ADMIN_EMAIL in .env).",
      ),
    );
  }

  if (a.posthog) {
    lines(stepHeader(9, total, "Connecting PostHog (optional)"));
    events.push({ kind: "prompt", prompt: PROMPTS.connectPosthog });
    if (a.connectPosthog) {
      lines([
        ...stepOk([t("PostHog connected to this local instance.")]),
        ...stepInfo(
          "After deploy, wire the event loop: `pnpm hogsend connect posthog --url https://your-instance`.",
        ),
      ]);
    } else {
      lines(
        stepInfo(
          "Re-run any time: `pnpm hogsend connect posthog` from this folder (app running).",
        ),
      );
    }
  }

  lines([
    [],
    [
      t("✓ Ready.", "green", true),
      t(" "),
      t("Welcome to Hogsend.", "plain", true),
    ],
    [
      t("  "),
      dim(
        "Local infra is up (Postgres, Redis, Hatchet) — your app isn't running yet. Start it:",
      ),
    ],
    [],
    [
      t("    "),
      cyan("pnpm hogsend dev"),
      dim("   # API + worker + Studio on :3002, one terminal"),
    ],
    [],
    [
      t("  "),
      dim("Studio".padEnd(9)),
      cyan(STUDIO_LOCAL_URL),
      dim("   # your dashboard (once dev is running)"),
    ],
    [
      t("  "),
      dim("Docs".padEnd(9)),
      cyan("https://docs.hogsend.com"),
      dim("   # guides + first journey: src/journeys/welcome.ts"),
    ],
    [
      t("  "),
      dim("Discord".padEnd(9)),
      cyan("https://discord.gg/rv6eZNvYrr"),
      dim("   # questions, help, and what we're shipping"),
    ],
    [],
    [
      t("  "),
      dim("Studio admin: "),
      cyan("pnpm studio:admin"),
      dim("   # create one anytime (sign-up is closed)"),
    ],
    [
      t("  "),
      dim("Hatchet dashboard: "),
      cyan("http://localhost:8888"),
      dim(" (admin@example.com / Admin123!!)"),
    ],
  ]);

  return events;
}

/* ------------------------------------------------------------- the machine -- */

export type PromptUi = {
  input: string;
  cursor: number;
  /** multiselect working set, seeded from the prompt's initial values */
  selected: ReadonlyArray<"app" | "posthog">;
  confirm: boolean;
};

const INITIAL_PROMPT_UI: PromptUi = {
  input: "",
  cursor: 0,
  selected: ["app"],
  confirm: true,
};

export type DemoState = {
  answers: ScaffoldAnswers;
  eventIndex: number;
  /** progress inside the current event */
  typed: number; // shell chars
  revealed: number; // lines shown
  spinTick: number;
  prompt: PromptUi;
  done: boolean;
};

export const INITIAL_DEMO_STATE: DemoState = {
  answers: INITIAL_ANSWERS,
  eventIndex: 0,
  typed: 0,
  revealed: 0,
  spinTick: 0,
  prompt: INITIAL_PROMPT_UI,
  done: false,
};

function advance(state: DemoState, events: DemoEvent[]): DemoState {
  const eventIndex = state.eventIndex + 1;
  return {
    ...state,
    eventIndex,
    typed: 0,
    revealed: 0,
    spinTick: 0,
    prompt: INITIAL_PROMPT_UI,
    done: eventIndex >= events.length,
  };
}

/** One clock tick: advances typing/reveal/spin; prompts wait for input. */
export function tickDemo(state: DemoState, events: DemoEvent[]): DemoState {
  if (state.done) return state;
  const event = events[state.eventIndex];
  switch (event.kind) {
    case "shell":
      return state.typed < event.command.length
        ? { ...state, typed: state.typed + 1 }
        : advance(state, events);
    case "lines":
      return state.revealed < event.lines.length
        ? { ...state, revealed: state.revealed + 1 }
        : advance(state, events);
    case "spinner":
      return state.spinTick < event.ticks
        ? { ...state, spinTick: state.spinTick + 1 }
        : advance(state, events);
    case "prompt":
      return state; // input-driven
  }
}

/* ------------------------------------------------------------ interaction -- */

export type DemoKey =
  | { type: "char"; ch: string }
  | { type: "backspace" }
  | { type: "enter" }
  | { type: "up" }
  | { type: "down" }
  | { type: "space" };

function submitPrompt(
  state: DemoState,
  spec: PromptSpec,
  version: string,
): DemoState {
  const a = { ...state.answers };
  const ui = state.prompt;
  switch (spec.kind) {
    case "text": {
      const value = ui.input;
      if (spec.id === "name") a.name = value === "" ? spec.placeholder : value;
      else if (spec.id === "domain") a.domain = value.toLowerCase();
      else if (spec.id === "adminEmail")
        a.adminEmail = value === "" ? spec.placeholder : value;
      else if (spec.id === "adminPassword") a.adminPassword = value;
      break; // adminConfirm keeps the stored password
    }
    case "multiselect":
      a.app = ui.selected.includes("app");
      a.posthog = ui.selected.includes("posthog");
      break;
    case "select":
      a.packageManager = spec.options[ui.cursor];
      break;
    case "confirm":
      a[spec.id] = ui.confirm;
      break;
    case "inline": {
      a[spec.id] = ui.input === "" ? spec.hint === "Y/n" : ui.input === "y";
      break;
    }
  }
  // Rebuild against the new answers: the tail past this prompt may change,
  // but everything up to and including it is identical, so the index holds.
  const next = { ...state, answers: a };
  return advance(next, buildEvents(a, version));
}

/** Apply one keystroke/tap to the active prompt. No-op outside a prompt. */
export function keyDemo(
  state: DemoState,
  events: DemoEvent[],
  key: DemoKey,
  version: string,
): DemoState {
  if (state.done) return state;
  const event = events[state.eventIndex];
  if (event.kind !== "prompt") return state;
  const spec = event.prompt;
  const ui = state.prompt;

  if (key.type === "enter") return submitPrompt(state, spec, version);

  switch (spec.kind) {
    case "text": {
      if (key.type === "char" && ui.input.length < 40)
        return { ...state, prompt: { ...ui, input: ui.input + key.ch } };
      if (key.type === "backspace")
        return { ...state, prompt: { ...ui, input: ui.input.slice(0, -1) } };
      if (key.type === "space" && ui.input.length < 40)
        return { ...state, prompt: { ...ui, input: `${ui.input} ` } };
      return state;
    }
    case "multiselect": {
      const count = spec.options.length;
      if (key.type === "down")
        return { ...state, prompt: { ...ui, cursor: (ui.cursor + 1) % count } };
      if (key.type === "up")
        return {
          ...state,
          prompt: { ...ui, cursor: (ui.cursor + count - 1) % count },
        };
      if (key.type === "space") {
        const value = spec.options[ui.cursor].value;
        const selected = ui.selected.includes(value)
          ? ui.selected.filter((v) => v !== value)
          : [...ui.selected, value];
        return { ...state, prompt: { ...ui, selected } };
      }
      return state;
    }
    case "select": {
      const count = spec.options.length;
      if (key.type === "down")
        return { ...state, prompt: { ...ui, cursor: (ui.cursor + 1) % count } };
      if (key.type === "up")
        return {
          ...state,
          prompt: { ...ui, cursor: (ui.cursor + count - 1) % count },
        };
      return state;
    }
    case "confirm": {
      if (key.type === "up" || key.type === "down" || key.type === "space")
        return { ...state, prompt: { ...ui, confirm: !ui.confirm } };
      if (key.type === "char" && (key.ch === "y" || key.ch === "n"))
        return { ...state, prompt: { ...ui, confirm: key.ch === "y" } };
      return state;
    }
    case "inline": {
      if (key.type === "char" && (key.ch === "y" || key.ch === "n"))
        return { ...state, prompt: { ...ui, input: key.ch } };
      if (key.type === "backspace")
        return { ...state, prompt: { ...ui, input: "" } };
      return state;
    }
  }
}

/* -------------------------------------------------------------- autopilot -- */

/**
 * The next scripted keystroke toward AUTOPILOT_ANSWERS for the active prompt.
 * Returns null when the current prompt needs no further input (never happens
 * mid-prompt — the last action is always the submitting "enter").
 */
export function autopilotKey(
  state: DemoState,
  events: DemoEvent[],
): DemoKey | null {
  const event = events[state.eventIndex];
  if (event.kind !== "prompt") return null;
  const spec = event.prompt;
  const ui = state.prompt;
  const target = AUTOPILOT_ANSWERS;

  switch (spec.kind) {
    case "text": {
      const goal =
        spec.id === "name"
          ? target.name
          : spec.id === "domain"
            ? target.domain
            : "";
      if (ui.input.length < goal.length)
        return { type: "char", ch: goal[ui.input.length] };
      return { type: "enter" };
    }
    case "multiselect": {
      const wantsPosthog = target.posthog;
      if (wantsPosthog && !ui.selected.includes("posthog")) {
        if (ui.cursor !== 1) return { type: "down" };
        return { type: "space" };
      }
      return { type: "enter" };
    }
    case "select": {
      const goal = spec.options.indexOf(target.packageManager);
      if (ui.cursor < goal) return { type: "down" };
      if (ui.cursor > goal) return { type: "up" };
      return { type: "enter" };
    }
    case "confirm":
      return ui.confirm === target[spec.id]
        ? { type: "enter" }
        : { type: "space" };
    case "inline":
      // both bootstrap questions ride their defaults: plain Enter
      return { type: "enter" };
  }
}

/* -------------------------------------------------------------- rendering -- */

/** A finished event, as it stays on the transcript. */
export function finalEventLines(
  event: DemoEvent,
  answers: ScaffoldAnswers,
): Line[] {
  switch (event.kind) {
    case "shell":
      return [[t("❯ ", "green"), t(event.command)]];
    case "lines":
      return event.lines;
    case "prompt":
      return submittedPromptLines(event.prompt, answers);
    case "spinner":
      return event.stop;
  }
}

const CURSOR: Span = { text: " ", tone: "cursor" };

/** The in-flight event: typing shell, revealing lines, spinning, or a live prompt. */
export function activeEventLines(
  state: DemoState,
  events: DemoEvent[],
): Line[] {
  if (state.done) return [[t("❯ ", "green"), CURSOR]];
  const event = events[state.eventIndex];
  switch (event.kind) {
    case "shell":
      return [
        [t("❯ ", "green"), t(event.command.slice(0, state.typed)), CURSOR],
      ];
    case "lines":
      return event.lines.slice(0, state.revealed);
    case "spinner": {
      const frames =
        event.style === "clack" ? CLACK_SPINNER_FRAMES : BRAILLE_SPINNER_FRAMES;
      const frame = frames[state.spinTick % frames.length];
      return event.style === "clack"
        ? [RAIL, [t(frame, "magenta"), t(`  ${event.label}`)]]
        : [[t("  "), cyan(frame), t(" "), dim(event.label)]];
    }
    case "prompt":
      return activePromptLines(event.prompt, state.prompt);
  }
}

/** Live clack prompt frame — cyan ◆, cyan rail, cyan └ end bar. */
export function activePromptLines(spec: PromptSpec, ui: PromptUi): Line[] {
  const bar = cyan("│");
  const end: Line = [cyan("└")];
  const head: Line = [cyan("◆"), t("  "), t(promptMessage(spec))];

  switch (spec.kind) {
    case "text": {
      // Like clack: the dim placeholder shows until the first keystroke, with
      // the block cursor sitting on its first character.
      const shown = spec.mask ? "▪".repeat(ui.input.length) : ui.input;
      const placeholder = ui.input === "" ? spec.placeholder : "";
      const cursor: Span =
        placeholder === "" ? CURSOR : { text: placeholder[0], tone: "cursor" };
      return [
        RAIL,
        head,
        [bar, t("  "), t(shown), cursor, dim(placeholder.slice(1))],
        end,
      ];
    }
    case "multiselect":
      return [
        RAIL,
        head,
        ...spec.options.map((option, i): Line => {
          const focused = i === ui.cursor;
          const selected = ui.selected.includes(option.value);
          const box = selected ? green("◼") : focused ? cyan("◻") : dim("◻");
          const label =
            focused || selected ? t(option.label) : dim(option.label);
          return focused
            ? [
                bar,
                t("  "),
                box,
                t(" "),
                label,
                t(" "),
                dim(`(${option.hint})`),
              ]
            : [bar, t("  "), box, t(" "), label];
        }),
        end,
      ];
    case "select":
      return [
        RAIL,
        head,
        ...spec.options.map(
          (option, i): Line =>
            i === ui.cursor
              ? [bar, t("  "), green("●"), t(` ${option}`)]
              : [bar, t("  "), dim("○"), t(" "), dim(option)],
        ),
        end,
      ];
    case "confirm": {
      const row: Line = ui.confirm
        ? [
            bar,
            t("  "),
            green("●"),
            t(" Yes "),
            dim("/"),
            dim(" ○ "),
            dim("No"),
          ]
        : [
            bar,
            t("  "),
            dim("○"),
            dim(" Yes "),
            dim("/"),
            t(" "),
            green("●"),
            t(" No"),
          ];
      return [RAIL, head, row, end];
    }
    case "inline":
      return [
        [
          t(`  ${spec.question} `),
          dim(`(${spec.hint})`),
          t(` ${ui.input}`),
          CURSOR,
        ],
      ];
  }
}

function promptMessage(spec: PromptSpec): string {
  return spec.kind === "inline" ? spec.question : spec.message;
}

/** Jump straight to the finished transcript (reduced motion). */
export function completeDemo(version: string): {
  state: DemoState;
  events: DemoEvent[];
} {
  const answers = AUTOPILOT_ANSWERS;
  const events = buildEvents(answers, version);
  return {
    state: {
      answers,
      eventIndex: events.length,
      typed: 0,
      revealed: 0,
      spinTick: 0,
      prompt: INITIAL_PROMPT_UI,
      done: true,
    },
    events,
  };
}
