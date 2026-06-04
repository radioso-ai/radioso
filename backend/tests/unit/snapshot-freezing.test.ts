import { describe, expect, it } from "vitest";

import { freezeAgent } from "../../src/modules/agents/public.js";
import { freezeRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import type { ConversationAgent } from "../../src/modules/agents/domain.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";

describe("freezeRetrievalSettings", () => {
  it("returns a workspace-independent value object without timestamps", () => {
    const record: RetrievalSettingsRecord = {
      workspaceId: "ws-1",
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "sem",
      lexicalRewriteInstructions: "lex",
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 2,
      rerankEnabled: true,
      vectorTopK: 12,
      similarityThreshold: 0.3,
      rerankTopK: 4,
      metadataRules: [],
      customInstruction: "be brief",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    };

    const snap = freezeRetrievalSettings(record);

    expect(snap).not.toHaveProperty("workspaceId");
    expect(snap).not.toHaveProperty("createdAt");
    expect(snap).not.toHaveProperty("updatedAt");
    expect(snap.vectorTopK).toBe(12);
    expect(snap.customInstruction).toBe("be brief");
  });

  it("snapshot is stable when the source record is later mutated", () => {
    const record: RetrievalSettingsRecord = {
      workspaceId: "ws-1",
      queryRewriteEnabled: true,
      semanticRewriteInstructions: "",
      lexicalRewriteInstructions: "",
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.2,
      rerankTopK: 5,
      metadataRules: [],
      customInstruction: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const snap = freezeRetrievalSettings(record);
    record.vectorTopK = 999;
    record.customInstruction = "mutated";

    expect(snap.vectorTopK).toBe(20);
    expect(snap.customInstruction).toBe("");
  });
});

describe("freezeAgent", () => {
  it("captures the fields that affect chat behavior, not surface settings", () => {
    const agent: ConversationAgent = {
      id: "agent-1",
      workspaceId: "ws-1",
      name: "Support Bot",
      createdAt: new Date(),
      updatedAt: new Date(),
      customInstruction: "Be helpful.",
      suggestedQuestionsEnabled: true,
      assistantLinkUtmEnabled: true,
      citationDisplayEnabled: true,
      contactRequestsEnabled: false,
      contactRequestDelivery: { recipientEmails: [], webhook: null },
      retrievalEnabled: true,
      logo: null,
      theme: {} as never,
      branding: {} as never,
      greetingInstruction: "Welcome!",
      assistantDefaultLocale: "en",
      proactiveGreetingEnabled: true,
      sourceScope: { mode: "all" },
      surfaceSettings: {} as never,
      chatModelOverride: null,
    };

    const snap = freezeAgent(agent);

    expect(snap.agentId).toBe("agent-1");
    expect(snap.name).toBe("Support Bot");
    expect(snap.customInstruction).toBe("Be helpful.");
    expect(snap.greetingInstruction).toBe("Welcome!");
    expect(snap.assistantDefaultLocale).toBe("en");
    expect(snap.retrievalEnabled).toBe(true);
    expect(snap).not.toHaveProperty("surfaceSettings");
    expect(snap).not.toHaveProperty("createdAt");
  });
});
