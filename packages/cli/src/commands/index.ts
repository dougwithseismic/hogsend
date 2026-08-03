import { attributionCommand } from "./attribution.js";
import { blueprintsCommand } from "./blueprints.js";
import { campaignsCommand } from "./campaigns.js";
import { connectCommand } from "./connect.js";
import { contactsCommand } from "./contacts.js";
import { devCommand } from "./dev.js";
import { doctorCommand } from "./doctor.js";
import { domainCommand } from "./domain.js";
import { ejectCommand } from "./eject.js";
import { emailsCommand } from "./emails.js";
import { envCommand } from "./env.js";
import { eventsCommand } from "./events.js";
import { flagsCommand } from "./flags.js";
import { hatchetCommand } from "./hatchet.js";
import { importCommand } from "./import.js";
import { journeysCommand } from "./journeys.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { openCommand } from "./open.js";
import { patchCommand } from "./patch.js";
import { publishCommand } from "./publish.js";
import { setupCommand } from "./setup.js";
import { skillsCommand } from "./skills.js";
import { statsCommand } from "./stats.js";
import { studioCommand } from "./studio.js";
import type { Command } from "./types.js";
import { upgradeCommand } from "./upgrade.js";
import { webhooksCommand } from "./webhooks.js";
import { whoamiCommand } from "./whoami.js";

/**
 * The command registry. The router (src/bin.ts) matches the leading argv token
 * against each `command.name` and dispatches to `run()`.
 *
 * Order here is the order shown in root help. The Hogsend Cloud commands
 * (login/whoami/logout/open/publish/env — these talk to the CONTROL PLANE, not to
 * an instance) come first because they are the first thing a new user runs;
 * then the data commands (agent-native, wrapping the engine's /v1/admin/*
 * routes); then the local scaffolding/maintenance commands (setup, skills,
 * eject, patch).
 */
export const commands: Command[] = [
  loginCommand,
  whoamiCommand,
  logoutCommand,
  publishCommand,
  openCommand,
  envCommand,
  doctorCommand,
  journeysCommand,
  blueprintsCommand,
  contactsCommand,
  importCommand,
  statsCommand,
  attributionCommand,
  eventsCommand,
  emailsCommand,
  campaignsCommand,
  webhooksCommand,
  domainCommand,
  connectCommand,
  hatchetCommand,
  studioCommand,
  devCommand,
  flagsCommand,
  setupCommand,
  skillsCommand,
  upgradeCommand,
  ejectCommand,
  patchCommand,
];

export type { Command, CommandContext } from "./types.js";
