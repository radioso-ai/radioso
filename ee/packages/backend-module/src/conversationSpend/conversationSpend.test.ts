import { describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { priceConversationSpend } from "./conversationSpend.js";

// Hand computations below use the catalog's list prices: gpt-5.4-mini $0.75 in / $4.50 out,
// gpt-5.4-nano $0.20 / $1.25, text-embedding-3-small $0.02, all per million tokens, at
// €0.90 per dollar. A price edit in plans.json is meant to break these.
describe("priceConversationSpend", () => {
  it("prices input and output tokens at list price, converts to euros, and averages over metered conversations", () => {
    const spend = priceConversationSpend({
      periodStart: "2026-06-01",
      meteredConversations: 4,
      usage: [
        // 100,000 in × $0.75/M = $0.075; 10,000 out × $4.50/M = $0.045 → $0.12
        { provider: "openai", model: "gpt-5.4-mini", inputTokens: 100_000, outputTokens: 10_000, calls: 20 },
        // 50,000 in × $0.20/M = $0.01; 4,000 out × $1.25/M = $0.005 → $0.015
        { provider: "openai", model: "gpt-5.4-nano", inputTokens: 50_000, outputTokens: 4_000, calls: 20 },
        // 5,000 in × $0.02/M = $0.0001
        { provider: "openai", model: "text-embedding-3-small", inputTokens: 5_000, outputTokens: 0, calls: 20 },
      ],
    });

    // $0.1351 × 0.9 = €0.12159; / 4 = €0.0303975
    expect(spend).toEqual({
      periodStart: "2026-06-01",
      meteredConversations: 4,
      spendEur: 0.12159,
      averageEurPerConversation: 0.030398,
      flagAboveEurPerConversation: PLAN_CATALOG.conversationSpendFlagEur,
      flagged: false,
      unpricedCalls: 0,
    });
  });

  it("flags an account whose average is above the catalog threshold", () => {
    // 60,000 in → $0.045; 3,000 out → $0.0135; $0.0585 × 0.9 = €0.05265 for one conversation
    const spend = priceConversationSpend({
      periodStart: "2026-06-01",
      meteredConversations: 1,
      usage: [{ provider: "openai", model: "gpt-5.4-mini", inputTokens: 60_000, outputTokens: 3_000, calls: 8 }],
    });

    expect(spend.averageEurPerConversation).toBe(0.05265);
    expect(spend.flagged).toBe(true);
  });

  it("counts calls on a model with no list price instead of pricing them", () => {
    const spend = priceConversationSpend({
      periodStart: "2026-06-01",
      meteredConversations: 1,
      usage: [
        { provider: "claude", model: "claude-sonnet-5", inputTokens: 900_000, outputTokens: 90_000, calls: 7 },
        // 10,000 in → $0.0075; 1,000 out → $0.0045; $0.012 × 0.9 = €0.0108
        { provider: "openai", model: "gpt-5.4-mini", inputTokens: 10_000, outputTokens: 1_000, calls: 2 },
      ],
    });

    expect(spend.spendEur).toBe(0.0108);
    expect(spend.unpricedCalls).toBe(7);
  });

  it("reports no average and no flag when the period metered no conversations", () => {
    const spend = priceConversationSpend({ periodStart: "2026-06-01", meteredConversations: 0, usage: [] });

    expect(spend.averageEurPerConversation).toBeNull();
    expect(spend.flagged).toBe(false);
  });
});
