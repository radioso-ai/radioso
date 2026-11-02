import { describe, expect, it } from "vitest";

import type { ConversationSpend } from "../lib/staff-auth-api";
import { conversationSpendText, formatEurPerConversation } from "../lib/spend-text";

const spend = (overrides: Partial<ConversationSpend> = {}): ConversationSpend => ({
  periodStart: "2026-06-01",
  meteredConversations: 12,
  spendEur: 0.25,
  averageEurPerConversation: 0.020833,
  flagAboveEurPerConversation: 0.04,
  flagged: false,
  unpricedCalls: 0,
  ...overrides,
});

describe("formatEurPerConversation", () => {
  it("shows a tenth of a cent, since the flag sits at a few cents", () => {
    expect(formatEurPerConversation(0.051539)).toBe("€0.052");
    expect(formatEurPerConversation(0.04)).toBe("€0.040");
  });
});

describe("conversationSpendText", () => {
  it("reads the month's average per metered conversation", () => {
    expect(conversationSpendText(spend())).toBe("€0.021 / conv");
  });

  it("marks an average that leaves out calls on unpriced models as partial", () => {
    expect(conversationSpendText(spend({ unpricedCalls: 3 }))).toBe("€0.021 / conv (partial)");
  });

  it("shows a dash when the month metered no conversation or the row carries no spend", () => {
    expect(conversationSpendText(spend({ meteredConversations: 0, averageEurPerConversation: null }))).toBe("—");
    expect(conversationSpendText(null)).toBe("—");
  });
});
