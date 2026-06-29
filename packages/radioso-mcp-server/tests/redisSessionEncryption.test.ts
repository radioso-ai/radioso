import { describe, expect, it } from "vitest";

import type { AccessSessionRecord } from "../src/auth/sessionStore.js";
import { deserializeSession, serializeSession } from "../src/state/redisRuntimeStore.js";

const signingSecret = "test-signing-secret";

const baseSession = (overrides: Partial<AccessSessionRecord>): AccessSessionRecord => ({
  sessionId: "sess-1",
  accessTokenHash: "hash-1",
  clientName: "vitest",
  grantedTools: ["ask_agent", "answer_grounded", "agent_resources"],
  approvalRequiredTools: [],
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  issuedAt: new Date("2029-12-31T00:00:00.000Z"),
  ...overrides,
} as AccessSessionRecord);

describe("redis session secrets are encrypted at rest", () => {
  it("never stores the converseSessionToken as plaintext", () => {
    const token = "converse-session-secret-xyz";
    const stored = serializeSession(baseSession({ converseSessionToken: token }), signingSecret);
    expect(stored).not.toContain(token);
  });

  it("round-trips the converseSessionToken through encryption", () => {
    const token = "converse-session-secret-xyz";
    const stored = serializeSession(baseSession({ converseSessionToken: token }), signingSecret);
    expect(deserializeSession(stored, signingSecret).converseSessionToken).toBe(token);
  });

  it("never stores the upstreamApiToken as plaintext and round-trips it", () => {
    const token = "upstream-api-secret-abc";
    const stored = serializeSession(baseSession({ upstreamApiToken: token }), signingSecret);
    expect(stored).not.toContain(token);
    expect(deserializeSession(stored, signingSecret).upstreamApiToken).toBe(token);
  });
});
