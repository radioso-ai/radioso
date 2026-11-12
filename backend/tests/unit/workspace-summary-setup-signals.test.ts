import { describe, expect, it, vi } from "vitest";

import { WorkspaceSummaryService } from "../../src/modules/workspace/services/workspaceSummaryService.js";
import { InMemoryWorkspaceSetupStateRepository } from "../support/inMemoryWorkspaceSetupState.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const build = (state: { readyDocuments: boolean; conversations: number }) => {
  const summarizeWorkspace = vi.fn(async () => ({
    documentCount: state.readyDocuments ? 1 : 0,
    readyDocumentCount: state.readyDocuments ? 1 : 0,
    pendingDocumentCount: 0,
    failedDocumentCount: 0,
    sampleDocumentCount: 0,
    sampleDocumentSlugs: [],
  }));
  const countByWorkspaceId = vi.fn(async () => state.conversations);
  const hasReadyDocuments = vi.fn(async () => state.readyDocuments);
  const hasAnyForWorkspace = vi.fn(async () => state.conversations > 0);
  const service = new WorkspaceSummaryService(
    { summarizeWorkspace, hasReadyDocuments } as never,
    { countByWorkspaceId, hasAnyForWorkspace } as never,
    new InMemoryWorkspaceSetupStateRepository(),
  );
  return { service, summarizeWorkspace, countByWorkspaceId };
};

describe("workspace setup signals", () => {
  it.each([
    { name: "a workspace nothing has happened in", state: { readyDocuments: false, conversations: 0 } },
    { name: "a workspace with documents and no conversation", state: { readyDocuments: true, conversations: 0 } },
    { name: "a workspace with documents and conversations", state: { readyDocuments: true, conversations: 12 } },
  ])("reports what the summary reports for $name", async ({ state }) => {
    const { service } = build(state);
    const summary = await service.getSummary(WORKSPACE_ID);
    const signals = await service.getSetupSignals(WORKSPACE_ID);

    expect(signals).toEqual({
      hasReadyDocuments: summary.hasReadyDocuments,
      hasCompletedChat: summary.hasCompletedChat,
      setup: summary.setup,
    });
  });

  it("answers without counting or aggregating the workspace's documents and conversations", async () => {
    // Ray reads this on every turn. The summary endpoint counts everything; this must not, because
    // a workspace with a long history would pay a scan for a boolean on each question.
    const { service, summarizeWorkspace, countByWorkspaceId } = build({ readyDocuments: true, conversations: 50_000 });
    await service.getSetupSignals(WORKSPACE_ID);
    expect(summarizeWorkspace).not.toHaveBeenCalled();
    expect(countByWorkspaceId).not.toHaveBeenCalled();
  });
});
