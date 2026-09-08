import { describe, expect, it, vi } from "vitest";

import { createSystemRetrievalDefaultsProvider } from "../../src/app/composition/retrievalDefaultsProvider.js";
import { ConversationContextService } from "../../src/modules/retrieval/services/conversationContextService.js";
import { RetrievalContextStageService } from "../../src/modules/retrieval/services/retrievalContextStage.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
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

const withStableTimestamps = (settings: RetrievalSettingsRecord): RetrievalSettingsRecord => ({
  ...settings,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("RetrievalContextStageService retrievalSettingsOverride", () => {
  it("returns system defaults stamped with the request workspace when no override is provided", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
      new ConversationContextService(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
    });

    expect(result.settings).toMatchObject({
      ...defaultRetrievalSettings("ws-1"),
      createdAt: result.settings.createdAt,
      updatedAt: result.settings.updatedAt,
    });
    expect(result.settings.similarityThreshold).toBe(RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold);
    expect(result.settings.workspaceId).toBe("ws-1");
  });

  it("shallow-merges retrievalSettingsOverride over system defaults", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
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
      createSystemRetrievalDefaultsProvider(),
      new ConversationContextService(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: { workspaceId: "ws-other" },
    });

    expect(result.settings.workspaceId).toBe("ws-1");
  });

  it("does not mutate the defaults record returned by the provider", async () => {
    const defaults = baseSettings("ws-1");
    const stage = new RetrievalContextStageService(
      { getDefaults() { return defaults; } },
      new ConversationContextService(),
    );

    await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      retrievalSettingsOverride: { vectorTopK: 999 },
    });

    expect(defaults.vectorTopK).toBe(20);
  });

  it("uses the defaults provider for the resolution base instead of workspace retrieval settings", async () => {
    const getDefaults = vi.fn((workspaceId: string) => baseSettings(workspaceId));
    const stage = new RetrievalContextStageService(
      { getDefaults },
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          rerankTopK: 7,
        },
      },
    });

    expect(getDefaults).toHaveBeenCalledWith("ws-1");
    expect(result.settings.vectorTopK).toBe(20);
    expect(result.settings.rerankTopK).toBe(7);
  });

  it("resolves agent retrieval skill settings over system defaults", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
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

  it("resolves suggested question overrides from the retrieval answer skill settings", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const disabled = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          suggestedQuestionsEnabled: false,
        },
      },
    });
    const countOverride = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          suggestedQuestionsCount: 4,
        },
      },
    });
    const inherited = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
    });

    expect(disabled.settings.suggestedQuestionsEnabled).toBe(false);
    expect(countOverride.settings.suggestedQuestionsCount).toBe(4);
    expect(inherited.settings.suggestedQuestionsEnabled).toBe(true);
    expect(inherited.settings.suggestedQuestionsCount).toBe(3);
  });

  it("resolves agent metadata rules as the effective retrieval metadata rules and inherits defaults when absent", async () => {
    const agentRule = {
      id: "agent-rule",
      field: "tier",
      valueType: "string",
      operator: "equals",
      value: "gold",
      effect: "filter",
      enabled: true,
      triggerMode: "always_on",
    } as const;
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const inherited = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: false,
        },
      },
    });
    const overridden = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          metadataRules: [agentRule],
        },
      },
    });

    expect(inherited.settings.metadataRules).toEqual([]);
    expect(overridden.settings.metadataRules).toHaveLength(1);
    expect(overridden.settings.metadataRules[0]).toMatchObject(agentRule);
    expect(overridden.settings.metadataRules).not.toEqual([]);
  });

  it("keeps empty agent skill settings at today's untuned workspace-default behavior", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
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

    expect(withStableTimestamps(withEmptySkillSettings.settings)).toEqual(
      withStableTimestamps(withoutSkillSettings.settings),
    );
    expect(withEmptySkillSettings.settings).toMatchObject({
      ...defaultRetrievalSettings("ws-1"),
      createdAt: withEmptySkillSettings.settings.createdAt,
      updatedAt: withEmptySkillSettings.settings.updatedAt,
    });
  });

  it("applies per-turn overrides after agent overrides", async () => {
    const stage = new RetrievalContextStageService(
      createSystemRetrievalDefaultsProvider(),
      new ConversationContextService(),
      createRetrievalSkillSettingsResolver(),
    );

    const result = await stage.execute({
      workspaceId: "ws-1",
      query: "q",
      history: [],
      agentSkillSettings: {
        "retrieval.answer": {
          queryRewriteEnabled: true,
          vectorTopK: 7,
          rerankTopK: 8,
        },
      },
      retrievalSettingsOverride: {
        vectorTopK: 4,
      },
    });

    expect(result.settings.queryRewriteEnabled).toBe(true);
    expect(result.settings.vectorTopK).toBe(4);
    expect(result.settings.rerankTopK).toBe(8);
    expect(result.settings.suggestedQuestionsCount).toBe(3);
  });
});

describe("RetrievalDefaultsProvider", () => {
  it("returns the system retrieval defaults with no behavior drift from an untuned workspace", () => {
    const provider = createSystemRetrievalDefaultsProvider();
    const workspaceId = "ws-1";
    const defaults = provider.getDefaults(workspaceId);
    const untunedWorkspaceDefaults = defaultRetrievalSettings(workspaceId);

    expect({
      ...defaults,
      createdAt: untunedWorkspaceDefaults.createdAt,
      updatedAt: untunedWorkspaceDefaults.updatedAt,
    }).toEqual(untunedWorkspaceDefaults);
    expect(defaults.similarityThreshold).toBe(RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold);
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

  it("ignores unknown retrieval override fields on the turn path", () => {
    const resolver = createRetrievalSkillSettingsResolver();

    const resolved = resolver.resolve("retrieval.answer", baseSettings("ws-1"), {
      vectorTopK: 7,
      futureField: "ignored",
    });

    expect(resolved.vectorTopK).toBe(7);
    expect(resolved).not.toHaveProperty("futureField");
  });

  it("drops invalid retrieval override fields on the turn path while preserving valid fields", () => {
    const resolver = createRetrievalSkillSettingsResolver();

    const resolved = resolver.resolve("retrieval.answer", baseSettings("ws-1"), {
      queryRewriteEnabled: false,
      vectorTopK: 0,
      rerankTopK: 6,
    });

    expect(resolved.queryRewriteEnabled).toBe(false);
    expect(resolved.vectorTopK).toBe(20);
    expect(resolved.rerankTopK).toBe(6);
  });
});
