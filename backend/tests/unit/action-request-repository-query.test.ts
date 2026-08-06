import { describe, expect, it, vi } from "vitest";

import { ActionRequestRepository } from "../../src/db/repositories/actionRequestRepository.js";

describe("ActionRequestRepository query shape", () => {
  it("limits the action outbox depth snapshot to claimable states", async () => {
    const builder = {
      select: vi.fn(() => builder),
      where: vi.fn(() => builder),
      executeTakeFirst: vi.fn(async () => ({
        pending_count: 0,
        in_progress_count: 0,
        oldest_pending_created_at: null,
      })),
    };
    const db = {
      selectFrom: vi.fn(() => builder),
    };
    const repository = new ActionRequestRepository(db as never);

    await repository.getPendingDepthSnapshot();

    expect(db.selectFrom).toHaveBeenCalledWith("routine_action_requests");
    expect(builder.where).toHaveBeenCalledWith("status", "in", ["pending", "in_progress"]);
  });
});
