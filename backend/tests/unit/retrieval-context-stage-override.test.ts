import { describe, expect, it, vi } from "vitest";

import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";

const baseSettings = (workspaceId: string): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: true,
  semanticRewriteInstructions: "",
  lexicalRewriteInstructions: "",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  rerankEnabled: false,
  vectorTopK: 20,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  customInstruction: "",
  metadataRules: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("RetrievalContextStageService retrievalSettingsOverride", () => {
  it("returns workspace settings unchanged when no override is provided", async () => {
    const stage = new RetrievalContextStageService(
      { async getForWorkspace(id: string) { return baseSettings(id); } } as never,
      new ConversationContextService(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
    });

    expect(result.settings.vectorTopK).toBe(20);
    expect(result.settings.similarityThreshold).toBe(0.2);
    expect(result.settings.workspaceId).toBe("ws-1");
  });

  it("shallow-merges retrievalSettingsOverride over workspace settings", async () => {
    const stage = new RetrievalContextStageService(
      { async getForWorkspace(id: string) { return baseSettings(id); } } as never,
      new ConversationContextService(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: {
        vectorTopK: 5,
        similarityThreshold: 0.9,
      },
    });

    expect(result.settings.vectorTopK).toBe(5);
    expect(result.settings.similarityThreshold).toBe(0.9);
    expect(result.settings.suggestedQuestionsCount).toBe(3);
  });

  it("preserves the resolved workspaceId even if override tries to change it", async () => {
    const stage = new RetrievalContextStageService(
      { async getForWorkspace(id: string) { return baseSettings(id); } } as never,
      new ConversationContextService(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: { workspaceId: "ws-other" } as never,
    });

    expect(result.settings.workspaceId).toBe("ws-1");
  });

  it("does not mutate the persisted record returned by the settings service", async () => {
    const persisted = baseSettings("ws-1");
    const stage = new RetrievalContextStageService(
      { async getForWorkspace() { return persisted; } } as never,
      new ConversationContextService(),
    );

    await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: { vectorTopK: 999 },
    });

    expect(persisted.vectorTopK).toBe(20);
  });

  it("never writes through the settings service when override is set", async () => {
    const update = vi.fn();
    const stage = new RetrievalContextStageService(
      { async getForWorkspace(id: string) { return baseSettings(id); }, updateForWorkspace: update } as never,
      new ConversationContextService(),
    );

    await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: { vectorTopK: 5 },
    });

    expect(update).not.toHaveBeenCalled();
  });
});
