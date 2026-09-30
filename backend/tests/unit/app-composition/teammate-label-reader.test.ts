import { describe, expect, it, vi } from "vitest";

import { createTeammateLabelReader } from "../../../src/app/composition/teammateLabelReader.js";

const user = (id: string, email: string, displayName: string | null = null) => ({ id, email, displayName });

describe("teammate label reader", () => {
  it("labels each teammate as teammates name each other, in one read of their profiles", async () => {
    const users = {
      findByIds: vi.fn(async () => [
        user("user-dana", "dana@example.com", "Dana Scully"),
        user("user-carl", "carl@acme.example"),
      ]),
    };
    const reader = createTeammateLabelReader({ users });

    const labels = await reader.labelsByUserIds(["user-dana", "user-carl", "user-gone"]);

    expect(users.findByIds).toHaveBeenCalledTimes(1);
    expect(users.findByIds).toHaveBeenCalledWith(["user-dana", "user-carl", "user-gone"]);
    expect([...labels]).toEqual([
      ["user-dana", "Dana Scully"],
      ["user-carl", "carl@acme.example"],
    ]);
  });

  it("reads nothing for no teammates", async () => {
    const users = { findByIds: vi.fn(async () => []) };

    await expect(createTeammateLabelReader({ users }).labelsByUserIds([])).resolves.toEqual(new Map());
    expect(users.findByIds).not.toHaveBeenCalled();
  });
});
