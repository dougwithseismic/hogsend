import type { DefinedConnectorAction } from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import {
  broadcastToChannel,
  dmMember,
  grantRole,
  mentionMembers,
  mentionRole,
  removeRole,
  sendChannelMessage,
} from "../actions/index.js";

/**
 * The audience contract for the Discord actions: only `dmMember` is
 * member-directed (so it mints a `discord` channel + gets preference-gated); the
 * channel/ops-directed actions declare NO audience and are never gated.
 */
describe("discord action audiences", () => {
  it("dmMember is member-directed and extracts args.member as the resolver ref", () => {
    expect(dmMember.audience?.kind).toBe("member");
    expect(
      dmMember.audience?.ref({ member: "user@example.com", content: "hi" }),
    ).toBe("user@example.com");
    // A raw snowflake ref is passed through verbatim (the engine resolver keys
    // on it directly).
    expect(
      dmMember.audience?.ref({ member: "987654321098765432", content: "hi" }),
    ).toBe("987654321098765432");
  });

  it("ops/channel-directed actions declare NO audience", () => {
    const opsActions: DefinedConnectorAction[] = [
      sendChannelMessage,
      broadcastToChannel,
      mentionMembers,
      mentionRole,
      grantRole,
      removeRole,
    ];
    for (const action of opsActions) {
      expect(action.audience).toBeUndefined();
    }
  });
});
