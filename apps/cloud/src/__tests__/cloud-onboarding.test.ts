import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEnvironmentUrl,
  PUBLISH_REPLACES_NOTE,
  SCAFFOLD_COMMANDS,
  welcomeEmailBody,
  welcomeEmailSubject,
} from "../lib/cloud-onboarding";

/**
 * What a web-first signup is told (PRD 13 T5).
 *
 * Someone who signed up before they had a repo has a running instance and no
 * idea what to run. Two surfaces answer that — the environment page and the
 * welcome email — and they share one declaration of the commands so they
 * cannot drift.
 */

const FACTS = {
  organizationName: "Acme",
  environmentName: "production",
  environmentId: "env_123",
};

describe("the scaffold commands", () => {
  it("scaffold, enter, log in, publish — in that order", () => {
    expect([...SCAFFOLD_COMMANDS]).toEqual([
      "pnpm dlx create-hogsend my-app",
      "cd my-app",
      "pnpm hogsend login",
      "pnpm hogsend publish",
    ]);
  });
});

describe("welcomeEmailBody", () => {
  it("carries every command and a link to THIS environment", () => {
    const body = welcomeEmailBody(FACTS);
    for (const command of SCAFFOLD_COMMANDS) {
      expect(body).toContain(command);
    }
    expect(body).toContain(buildEnvironmentUrl("env_123"));
    expect(buildEnvironmentUrl("env_123")).toMatch(/\/environments\/env_123$/);
  });

  it("says publish REPLACES the stock scaffold already running", () => {
    // The non-obvious fact. Without it people assume they have to start over,
    // or that publishing will strand the instance they are looking at.
    expect(welcomeEmailBody(FACTS)).toContain(PUBLISH_REPLACES_NOTE);
    expect(PUBLISH_REPLACES_NOTE).toContain("REPLACES");
  });

  it("names the org and environment in the subject", () => {
    expect(welcomeEmailSubject(FACTS)).toContain("Acme/production");
  });
});

describe("the environment page", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../components/cloud/tenant-access-section.tsx",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("renders the commands from the shared constant, not by hand", () => {
    expect(source).toContain("SCAFFOLD_COMMANDS");
    expect(source).toContain("PUBLISH_REPLACES_NOTE");
    // A second hand-typed copy is how a dashboard and an email drift apart.
    expect(source).not.toContain("create-hogsend my-app");
  });
});
