import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  issueConverseChatSession,
  verifyConverseChatSession,
} from "../../../src/modules/settings/contracts/publicChatSession.js";

const SECRET = "00112233445566778899aabbccddeeff";

/** Mints a token in the flat shape the previous release signed. */
const signLegacyGrantSession = (claims: Record<string, unknown>): string => {
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
};

describe("converse chat session payload", () => {
  it("still parses a session signed before the origin became a union", () => {
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const publicSessionId = randomUUID();
    const grantId = randomUUID();
    const token = signLegacyGrantSession({
      workspaceId,
      agentId,
      publicSessionId,
      sourceChannel: "mcp",
      sourceOrigin: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantId,
      grantVersion: "version-1",
    });

    expect(verifyConverseChatSession(token, SECRET)).toMatchObject({
      workspaceId,
      agentId,
      publicSessionId,
      origin: { kind: "grant", grantId, grantVersion: "version-1" },
    });
  });

  it("refuses a session that carries neither shape of origin", () => {
    const token = signLegacyGrantSession({
      workspaceId: randomUUID(),
      agentId: randomUUID(),
      publicSessionId: randomUUID(),
      sourceChannel: "mcp",
      sourceOrigin: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(verifyConverseChatSession(token, SECRET)).toBeNull();
  });

  it("round-trips a walk-in origin", () => {
    const session = issueConverseChatSession(SECRET, {
      workspaceId: randomUUID(),
      agentId: randomUUID(),
      publicSessionId: randomUUID(),
      origin: { kind: "walk_in", publicId: "ag_0123456789abcdefghijkl" },
    });

    expect(verifyConverseChatSession(session.token, SECRET)).toMatchObject({
      origin: { kind: "walk_in", publicId: "ag_0123456789abcdefghijkl" },
    });
  });
});
