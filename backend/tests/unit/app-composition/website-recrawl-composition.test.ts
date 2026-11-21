import { describe, expect, it, vi } from "vitest";

import {
  recrawlPlanFromUsageLimits,
  websiteRecrawlPeriodicTask,
} from "../../../src/app/composition/websiteRecrawl.js";

describe("website recrawl composition", () => {
  it("reads the plan's fastest recrawl cadence from the usage limit policy", async () => {
    const getFastestRecrawlCadence = vi.fn().mockResolvedValue("weekly");
    const plan = recrawlPlanFromUsageLimits({ getFastestRecrawlCadence });

    await expect(plan.fastestRecrawlCadence({ workspaceId: "workspace-1" })).resolves.toBe("weekly");
    expect(getFastestRecrawlCadence).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
  });

  it("sets no ceiling for a deployment whose policy has no plans", async () => {
    await expect(recrawlPlanFromUsageLimits({}).fastestRecrawlCadence({ workspaceId: "workspace-1" })).resolves.toBe("daily");
    await expect(recrawlPlanFromUsageLimits({ getFastestRecrawlCadence: async () => null })
      .fastestRecrawlCadence({ workspaceId: "workspace-1" })).resolves.toBe("daily");
  });

  it("runs the sweep as the website-recrawl periodic task, every 15 minutes", async () => {
    const run = vi.fn().mockResolvedValue({ due: 0, enqueued: 0, skippedActive: 0, failed: 0 });
    const task = websiteRecrawlPeriodicTask({ run });

    expect(task.id).toBe("website-recrawl");
    expect(task.intervalMs).toBe(15 * 60 * 1_000);
    await task.handle.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
