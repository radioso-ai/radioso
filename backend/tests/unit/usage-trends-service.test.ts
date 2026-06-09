import { describe, expect, it, vi } from "vitest";

import { UsageTrendsService } from "../../src/modules/reporting/service.js";
import type { ApplicationDatabasePort } from "../../src/app/composition/applicationModule.js";

const accountId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";

class RecordingDatabase implements ApplicationDatabasePort {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];
  private responses: unknown[][];

  constructor(responses: unknown[][]) {
    this.responses = [...responses];
  }

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ text, params });
    return (this.responses.shift() ?? []) as T[];
  }
}

describe("UsageTrendsService", () => {
  it("requires active account membership before reading aggregates", async () => {
    const database = new RecordingDatabase([]);
    const access = {
      requireActiveMembership: vi.fn().mockRejectedValue(Object.assign(new Error("no access"), { statusCode: 401 })),
    };
    const service = new UsageTrendsService(database, access);

    await expect(service.getUsageTrends({
      accountId,
      userId,
      from: "2026-06-01",
      to: "2026-06-02",
      granularity: "day",
    })).rejects.toMatchObject({ statusCode: 401 });

    expect(database.calls).toEqual([]);
  });

  it("validates workspace and agent filters against the account before aggregate queries", async () => {
    const database = new RecordingDatabase([
      [{ exists: true }],
      [{ exists: true }],
      [],
      [],
      [],
    ]);
    const access = { requireActiveMembership: vi.fn().mockResolvedValue({ id: "membership-1" }) };
    const service = new UsageTrendsService(database, access);

    await service.getUsageTrends({
      accountId,
      userId,
      from: "2026-06-01",
      to: "2026-06-01",
      granularity: "day",
      workspaceId,
      agentId,
    });

    expect(access.requireActiveMembership).toHaveBeenCalledWith(accountId, userId);
    expect(database.calls[0]?.text).toMatch(/FROM workspaces/i);
    expect(database.calls[0]?.params).toEqual([accountId, workspaceId]);
    expect(database.calls[1]?.text).toMatch(/FROM agents/i);
    expect(database.calls[1]?.text).toMatch(/JOIN workspaces/i);
    expect(database.calls[1]?.params).toEqual([accountId, agentId]);
    expect(database.calls).toHaveLength(5);
  });

  it("rejects cross-account workspace filters without running aggregate queries", async () => {
    const database = new RecordingDatabase([[{ exists: false }]]);
    const access = { requireActiveMembership: vi.fn().mockResolvedValue({ id: "membership-1" }) };
    const service = new UsageTrendsService(database, access);

    await expect(service.getUsageTrends({
      accountId,
      userId,
      from: "2026-06-01",
      to: "2026-06-01",
      granularity: "day",
      workspaceId,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });

    expect(database.calls).toHaveLength(1);
  });
});
