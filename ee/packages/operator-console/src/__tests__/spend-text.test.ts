import { describe, expect, it } from "vitest";

import type { ConversationSpend } from "../lib/staff-auth-api";
import { averageText, conversationSpendText, formatEurPerConversation } from "../lib/spend-text";

const spend = (overrides: Partial<ConversationSpend> = {}): ConversationSpend => ({
  periodStart: "2026-06-01",
  repliesPerConversation: 10,
  meteredConversations: 12,
  spendEur: 0.25,
  averageEurPerConversation: 0.020833,
  flagAboveEurPerConversation: 0.04,
  flag: "below",
  unpricedCalls: 0,
  ...overrides,
});

describe("formatEurPerConversation", () => {
  it("shows a tenth of a cent, since the flag sits at a few cents", () => {
    expect(formatEurPerConversation(0.051539)).toBe("€0.052");
    expect(formatEurPerConversation(0.04)).toBe("€0.040");
  });
});

describe("averageText", () => {
  it("reads an average with every call priced as the figure itself", () => {
    expect(averageText(spend())).toBe("€0.021");
  });

  it("reads an average missing unpriced calls as a floor, since those calls can only add to it", () => {
    expect(averageText(spend({ unpricedCalls: 3, flag: "undetermined" }))).toBe("≥ €0.021");
  });

  it("shows a dash when the month metered no conversation", () => {
    expect(averageText(spend({ meteredConversations: 0, averageEurPerConversation: null, flag: "none" }))).toBe("—");
  });
});

describe("conversationSpendText", () => {
  it("reads the month's average per metered conversation", () => {
    expect(conversationSpendText(spend())).toBe("€0.021 / conv");
  });

  it("calls an average under the flag undetermined when unpriced calls are missing from it", () => {
    expect(conversationSpendText(spend({ unpricedCalls: 3, flag: "undetermined" }))).toBe("≥ €0.021 / conv (undetermined)");
  });

  it("keeps a flagged average flagged even with unpriced calls missing, as a floor", () => {
    expect(conversationSpendText(spend({ averageEurPerConversation: 0.052, unpricedCalls: 3, flag: "above" }))).toBe("≥ €0.052 / conv");
  });

  it("shows a dash when the month metered no conversation or the row carries no spend", () => {
    expect(conversationSpendText(spend({ meteredConversations: 0, averageEurPerConversation: null, flag: "none" }))).toBe("—");
    expect(conversationSpendText(null)).toBe("—");
  });
});
