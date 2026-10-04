import { describe, expect, it } from "vitest";

import { overLimitResources } from "../lib/tier-change";

const meters = (overrides: Partial<Parameters<typeof overLimitResources>[0]> = {}) => ({
  monthlyAnswers: { used: 0, limit: null },
  storedDocuments: { used: 0, limit: null },
  storedIndexedBytes: { used: 0, limit: null },
  monthlyIndexedBytes: { used: 0, limit: null },
  monthlyConversations: null,
  ...overrides,
});

const tier = (overrides: Partial<Parameters<typeof overLimitResources>[1]> = {}) => ({
  monthlyAnswerLimit: null,
  storedDocumentLimit: null,
  storedIndexedByteLimit: null,
  monthlyIndexedByteLimit: null,
  monthlyConversationLimit: null,
  ...overrides,
});

const conversationMeter = { periodStart: "2026-06-01", resetAt: "2026-07-01T00:00:00.000Z", credits: 0, byKind: { conversation: 0, copilot: 0, test_run: 0, pulse_report: 0 } };

describe("overLimitResources", () => {
  it("warns on the answer cap when a conversation-metered account moves to an answer-metered tier", () => {
    const usage = meters({
      monthlyAnswers: { used: 620, limit: null },
      monthlyConversations: { ...conversationMeter, used: 62, limit: 50 },
    });

    expect(overLimitResources(usage, tier({ monthlyAnswerLimit: 100 }))).toEqual(["monthlyAnswers"]);
  });

  it("warns on conversations, first, when the target tier caps them below current usage", () => {
    const usage = meters({
      monthlyConversations: { ...conversationMeter, used: 900, limit: 5000 },
      storedDocuments: { used: 9000, limit: null },
    });

    expect(overLimitResources(usage, tier({ monthlyConversationLimit: 50, storedDocumentLimit: 2000 })))
      .toEqual(["monthlyConversations", "storedDocuments"]);
  });

  it("ignores the target tier's answer cap when that tier meters conversations", () => {
    const usage = meters({ monthlyAnswers: { used: 620, limit: null } });

    expect(overLimitResources(usage, tier({ monthlyAnswerLimit: 100, monthlyConversationLimit: 5000 }))).toEqual([]);
  });

  it("stays quiet when the target tier is above every meter", () => {
    const usage = meters({
      monthlyAnswers: { used: 7, limit: 10 },
      storedDocuments: { used: 3, limit: 20 },
    });

    expect(overLimitResources(usage, tier({ monthlyAnswerLimit: 100, storedDocumentLimit: 200 }))).toEqual([]);
  });

  it("treats an absent limit as uncapped rather than as zero", () => {
    const usage = meters({ storedDocuments: { used: 9000, limit: 20 } });

    expect(overLimitResources(usage, tier())).toEqual([]);
  });
});
