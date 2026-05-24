import { describe, expect, it } from "vitest";

import { WorkspaceTokenRepository } from "../../src/db/repositories/workspaceTokenRepository.js";

const tokenRow = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  account_id: "33333333-3333-4333-8333-333333333333",
  token_prefix: "radioso_",
  token_hash: "token-hash",
  encrypted_token: "encrypted",
  created_at: new Date("2026-05-24T10:00:00.000Z"),
  last_used_at: null,
  revoked_at: null,
};

describe("WorkspaceTokenRepository", () => {
  it("filters revoked tokens when loading by token hash", async () => {
    const calls: string[] = [];
    const repository = new WorkspaceTokenRepository({
      query: async <T>(sql: string) => {
        calls.push(sql);
        return [tokenRow as T];
      },
    } as never);

    const token = await repository.findByTokenHash("token-hash");

    expect(token?.revokedAt).toBeNull();
    expect(calls[0]).toMatch(/revoked_at IS NULL/);
  });

  it("clears revocation state when replacing a workspace token", async () => {
    const calls: string[] = [];
    const repository = new WorkspaceTokenRepository({
      query: async <T>(sql: string) => {
        calls.push(sql);
        return [tokenRow as T];
      },
    } as never);

    await repository.save({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      accountId: "33333333-3333-4333-8333-333333333333",
      tokenPrefix: "radioso_",
      tokenHash: "new-token-hash",
      encryptedToken: "new-encrypted-token",
    });

    expect(calls[0]).toMatch(/revoked_at = NULL/);
  });
});
