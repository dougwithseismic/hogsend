import { contactsCommand } from "./contacts.js";
import { doctorCommand } from "./doctor.js";
import { ejectCommand } from "./eject.js";
import { eventsCommand } from "./events.js";
import { journeysCommand } from "./journeys.js";
import { patchCommand } from "./patch.js";
import { setupCommand } from "./setup.js";
import { skillsCommand } from "./skills.js";
import { statsCommand } from "./stats.js";
import { studioCommand } from "./studio.js";
import type { Command } from "./types.js";

/**
 * The command registry. The router (src/bin.ts) matches the leading argv token
 * against each `command.name` and dispatches to `run()`.
 *
 * Order here is the order shown in root help. Data commands (agent-native,
 * wrapping the engine's /v1/admin/* routes) come first, then the local
 * scaffolding/maintenance commands (setup, skills, eject, patch).
 */
export const commands: Command[] = [
  doctorCommand,
  journeysCommand,
  contactsCommand,
  statsCommand,
  eventsCommand,
  studioCommand,
  setupCommand,
  skillsCommand,
  ejectCommand,
  patchCommand,
];

export type { Command, CommandContext } from "./types.js";
