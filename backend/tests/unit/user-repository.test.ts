import { describe, expect, it } from "vitest";

import { UserRepository } from "../../src/db/repositories/userRepository.js";

describe("UserRepository", () => {
  it("selects email_verified_at when loading a user by email", async () => {
    const calls: string[] = [];
    const repository = new UserRepository({
      queryOptional: async (sql: string) => {
        calls.push(sql);
        return {
          id: "user-1",
          email: "user@example.com",
          password_hash: "hash",
          email_verified_at: new Date("2026-01-01T00:00:00.000Z"),
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          updated_at: new Date("2026-01-01T00:00:00.000Z"),
        };
      },
      pool: {
        query: async () => ({ rowCount: 0 }),
      },
    } as never);

    const user = await repository.findByEmail("user@example.com");

    expect(calls[0]).toContain("email_verified_at");
    expect(user?.emailVerifiedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});
