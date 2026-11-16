import { describe, expect, it, vi } from "vitest";

import { WorkspaceSummaryService } from "../../src/modules/workspace/public.js";
import { InMemoryWorkspaceSetupStateRepository } from "../support/inMemoryWorkspaceSetupState.js";

const documentRepository = {
  summarizeWorkspace: vi.fn(async () => ({
    documentCount: 2,
    readyDocumentCount: 1,
    pendingDocumentCount: 1,
    sampleDocumentCount: 0,
    sampleDocumentSlugs: [],
  })),
};
const conversationRepository = { countByWorkspaceId: vi.fn(async () => 3) };

const summaryService = (isChatConfigured: (workspaceId: string) => Promise<boolean>) =>
  new WorkspaceSummaryService(
    documentRepository as never,
    conversationRepository as never,
    new InMemoryWorkspaceSetupStateRepository(),
    { websiteCrawlerEnabled: true, chatReadiness: { isChatConfigured: vi.fn(isChatConfigured) } },
  );

describe("WorkspaceSummaryService llmConfigured", () => {
  it("is true when the workspace's chat model is configured", async () => {
    const isChatConfigured = vi.fn(async () => true);

    const summary = await summaryService(isChatConfigured).getSummary("workspace-1");

    expect(summary.llmConfigured).toBe(true);
    expect(isChatConfigured).toHaveBeenCalledWith("workspace-1");
  });

  it("is false when the workspace's chat model is not configured", async () => {
    const summary = await summaryService(async () => false).getSummary("workspace-1");

    expect(summary.llmConfigured).toBe(false);
  });

  it("adds only the boolean to the onboarding contract, next to the setup state", async () => {
    const summary = await summaryService(async () => true).getSummary("workspace-1");

    expect(Object.keys(summary).sort()).toEqual([
      "conversationCount",
      "documentCount",
      "hasCompletedChat",
      "hasDocuments",
      "hasPendingDocuments",
      "hasReadyDocuments",
      "llmConfigured",
      "pendingDocumentCount",
      "readyDocumentCount",
      "sampleDocumentCount",
      "sampleDocumentSlugs",
      "sampleDocumentsImported",
      "setup",
      "websiteCrawlerEnabled",
    ]);
  });
});
