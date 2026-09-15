import { describe, expect, it, vi } from "vitest";

// `surfaceWeight()` must price every kind off `PLAN_CATALOG.countsAs`, the
// single source of truth documented in `@radioso/plan-catalog`'s README and
// PR #1253. This module is mocked to a fixture that differs from the real
// catalog on purpose: if `surfaceWeight()` ever regresses back to numbers it
// reimplements by hand (as it did before this test existed), the assertions
// below — derived from this same fixture, never from a copy-pasted literal —
// stop matching and the test fails, even though the *real* catalog's numbers
// would still coincidentally match a hand-kept-in-sync implementation.
const countsAsFixture = {
  conversation: 2,
  copilot: 3,
  test_run: 0.4,
  pulse_report: 7,
  other: 0,
};

vi.mock("@radioso/plan-catalog", () => ({
  PLAN_CATALOG: { countsAs: countsAsFixture },
}));

const { PLAN_CATALOG } = await import("@radioso/plan-catalog");
const { surfaceWeight, TENTHS_PER_CONVERSATION, USAGE_KINDS } = await import("./usageLimitService.js");

describe("surfaceWeight", () => {
  it("never charges the widget greeting", () => {
    expect(surfaceWeight("chat.bootstrap")).toBeNull();
  });

  it("derives every mapped kind's tenths from PLAN_CATALOG.countsAs, not a hardcoded literal", () => {
    const cases: Array<{ surface: string; kind: keyof typeof countsAsFixture; perConversationBlock: boolean }> = [
      { surface: "operator_copilot", kind: "copilot", perConversationBlock: false },
      { surface: "operator_copilot_probe", kind: "copilot", perConversationBlock: false },
      { surface: "authenticated_chat", kind: "test_run", perConversationBlock: false },
      { surface: "workbench_replay", kind: "test_run", perConversationBlock: false },
      { surface: "eval_replay", kind: "test_run", perConversationBlock: false },
      { surface: "audience_pulse", kind: "pulse_report", perConversationBlock: false },
      { surface: "retrieval.answer", kind: "conversation", perConversationBlock: false },
      { surface: "mcp.retrieval_answer", kind: "conversation", perConversationBlock: false },
      // Every other surface (website_embed, anonymous, slack, whatsapp, agent_api, mcp, assistant, ...)
      // falls into the default: a customer conversation charged once per reply-block.
      { surface: "website_embed", kind: "conversation", perConversationBlock: true },
      { surface: "slack", kind: "conversation", perConversationBlock: true },
    ];

    for (const { surface, kind, perConversationBlock } of cases) {
      const weight = surfaceWeight(surface);
      expect(weight).not.toBeNull();
      expect(weight).toEqual({
        kind,
        tenths: PLAN_CATALOG.countsAs[kind] * TENTHS_PER_CONVERSATION,
        perConversationBlock,
      });
    }
  });
});

describe("USAGE_KINDS", () => {
  it("mirrors PLAN_CATALOG.countsAs, minus the catalog's reserved `other` kind", () => {
    expect(new Set(USAGE_KINDS)).toEqual(new Set(["conversation", "copilot", "test_run", "pulse_report"]));
    expect(USAGE_KINDS).not.toContain("other");
  });
});
