import { describe, expect, it, vi } from "vitest";

import { FacetExtractionWorkspaceDrainService } from "../../../src/modules/facets/services/facetExtractionWorkspaceDrainService.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ANALYSIS_START = new Date("2026-07-01T00:00:00.000Z");
const ANALYSIS_END = new Date("2026-08-01T00:00:00.000Z");
const input = { workspaceId: WORKSPACE_ID, analysisStart: ANALYSIS_START, analysisEnd: ANALYSIS_END };

describe("FacetExtractionWorkspaceDrainService", () => {
  it("schedules the next durable slice at the job's due time", async () => {
    const scheduledAt = new Date("2026-08-25T12:00:00.000Z");
    const dispatcher = { requestWorkspaceDrain: vi.fn(async () => undefined) };
    const service = new FacetExtractionWorkspaceDrainService({
      async nextWorkspaceScheduledAt() { return scheduledAt; },
      async hasPendingWorkspaceWork() { return true; },
    }, dispatcher);

    await expect(service.requestWorkspaceDrain(input)).resolves.toBe(true);
    expect(dispatcher.requestWorkspaceDrain).toHaveBeenCalledWith({ ...input, scheduleAt: scheduledAt });
  });

  it("does not enqueue an empty workspace", async () => {
    const dispatcher = { requestWorkspaceDrain: vi.fn(async () => undefined) };
    const service = new FacetExtractionWorkspaceDrainService({
      async nextWorkspaceScheduledAt() { return null; },
      async hasPendingWorkspaceWork() { return false; },
    }, dispatcher);

    await expect(service.requestWorkspaceDrain(input)).resolves.toBe(false);
    expect(dispatcher.requestWorkspaceDrain).not.toHaveBeenCalled();
  });
});
