import { describe, expect, it, vi } from "vitest";

import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";
import { createRetrievalSkillSettingsResolver } from "../../src/app/composition/skillSettingsResolver.js";

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

  it("resolves agent retrieval skill settings over workspace defaults", async () => {
    const stage = new RetrievalContextStageService(
      { async getForWorkspace(id: string) { return baseSettings(id); } } as never,
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: false,
          vectorTopK: 7,
        },
      },
    });

    expect(result.settings.queryRewriteEnabled).toBe(false);
    expect(result.settings.vectorTopK).toBe(7);
    expect(result.settings.rerankTopK).toBe(5);
  });

  it("keeps empty agent skill settings at today's workspace-default behavior", async () => {
    const defaults = baseSettings("ws-1");
    const stage = new RetrievalContextStageService(
      { async getForWorkspace() { return defaults; } } as never,
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const withoutSkillSettings = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
    });
    const withEmptySkillSettings = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {},
    });

    expect(withEmptySkillSettings.settings).toEqual(withoutSkillSettings.settings);
  });
});

describe("SkillSettingsResolver", () => {
  it("inherits absent fields and preserves explicit overrides across default changes", () => {
    const resolver = createRetrievalSkillSettingsResolver();
    const firstDefaults = baseSettings("ws-1");
    const agentOverride = {
      vectorTopK: 7,
    };

    const first = resolver.resolve("retrieval.answer", firstDefaults, agentOverride);
    const second = resolver.resolve("retrieval.answer", {
      ...firstDefaults,
      queryRewriteEnabled: false,
      vectorTopK: 30,
      rerankTopK: 9,
    }, agentOverride);

    expect(first.vectorTopK).toBe(7);
    expect(first.queryRewriteEnabled).toBe(true);
    expect(second.vectorTopK).toBe(7);
    expect(second.queryRewriteEnabled).toBe(false);
    expect(second.rerankTopK).toBe(9);
  });

  it("rejects invalid retrieval overrides through the retrieval skill settings schema", () => {
    const resolver = createRetrievalSkillSettingsResolver();

    expect(() =>
      resolver.resolve("retrieval.answer", baseSettings("ws-1"), {
        vectorTopK: 0,
      }),
    ).toThrow(/vectorTopK/);
  });
});
