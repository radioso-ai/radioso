import { describe, expect, it } from "vitest";

import { serializeSession, purgeLegacyApiTokenSessions } from "../src/state/redisRuntimeStore.js";

const session = (input: { sessionId: string; accessTokenHash: string; upstreamApiToken?: string }) => ({
  accessTokenHash: input.accessTokenHash,
  expiresAt: new Date("2999-01-01T00:00:00.000Z"),
  grantedTools: ["search_documents"],
  issuedAt: new Date("2026-08-31T00:00:00.000Z"),
  sessionId: input.sessionId,
  ...(input.upstreamApiToken ? { upstreamApiToken: input.upstreamApiToken } : {}),
});

describe("Redis MCP runtime-store legacy purge", () => {
  it("uses SCAN and removes legacy records plus indexes without deleting converse sessions", async () => {
    const values = new Map<string, string>([
      ["radioso-mcp:session:id:legacy", serializeSession(session({
        accessTokenHash: "legacy-hash",
        sessionId: "legacy",
        upstreamApiToken: "radioso_legacy",
      }), "signing-secret")],
      ["radioso-mcp:session:id:converse", JSON.stringify({
        accessTokenHash: "converse-hash",
        expiresAt: "2999-01-01T00:00:00.000Z",
        grantedTools: ["ask_agent"],
        issuedAt: "2026-08-31T00:00:00.000Z",
        sessionId: "converse",
        converseSessionTokenEncrypted: { authTag: "tag", ciphertext: "cipher", iv: "iv" },
      })],
      ["radioso-mcp:session:token:legacy-hash", "legacy"],
      ["radioso-mcp:session:token:converse-hash", "converse"],
      ["radioso-mcp:session:token:orphan", "missing"],
    ]);
    const deleted: string[][] = [];
    const scannedPatterns: string[] = [];
    const client = {
      async *scanIterator(options: { MATCH: string }) {
        scannedPatterns.push(options.MATCH);
        for (const key of values.keys()) {
          if (key.includes(":session:id:") && options.MATCH.includes(":session:id:")) yield key;
          if (key.includes(":session:token:") && options.MATCH.includes(":session:token:")) yield key;
        }
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async del(keys: string[]) {
        deleted.push(keys);
        for (const key of keys) values.delete(key);
        return keys.length;
      },
    };

    await expect(purgeLegacyApiTokenSessions(client, "radioso-mcp", "signing-secret"))
      .resolves.toEqual({ purgedSessionCount: 1 });

    expect(scannedPatterns).toEqual([
      "radioso-mcp:session:id:*",
      "radioso-mcp:session:token:*",
    ]);
    expect(deleted).toEqual(expect.arrayContaining([
      ["radioso-mcp:session:id:legacy", "radioso-mcp:session:token:legacy-hash"],
      ["radioso-mcp:session:token:orphan"],
    ]));
    expect(values.has("radioso-mcp:session:id:converse")).toBe(true);
    expect(values.has("radioso-mcp:session:token:converse-hash")).toBe(true);

    await expect(purgeLegacyApiTokenSessions(client, "radioso-mcp", "signing-secret"))
      .resolves.toEqual({ purgedSessionCount: 0 });
  });
});
