import { describe, expect, it } from "vitest";

import { copilotTurnRequestSchema } from "../../../src/modules/operatorCopilot/public.js";

const request = (pageContext: Record<string, unknown>) => ({
  conversationId: null,
  message: "Investigate this",
  pageContext,
});

describe("copilot turn page context", () => {
  it("accepts the v2 viewing context and truncates selected operator data", () => {
    const parsed = copilotTurnRequestSchema.parse(request({
      view: "copilot",
      agentId: null,
      conversationId: null,
      selection: "x".repeat(2_100),
      entities: [{
        type: "conversation",
        id: "conversation-1",
        label: "Checkout question",
        focused: true,
      }],
    }));

    expect(parsed.pageContext.selection).toHaveLength(2_000);
    expect(parsed.pageContext.entities).toEqual([{
      type: "conversation",
      id: "conversation-1",
      label: "Checkout question",
      focused: true,
    }]);
  });

  it("defaults optional v2 fields and rejects entity limits", () => {
    expect(copilotTurnRequestSchema.parse(request({
      view: "history",
      agentId: null,
      conversationId: null,
    })).pageContext).toMatchObject({ selection: null, entities: [] });

    expect(() => copilotTurnRequestSchema.parse(request({
      view: "history",
      agentId: null,
      conversationId: null,
      entities: Array.from({ length: 31 }, (_, index) => ({
        type: "document",
        id: `document-${index}`,
        label: "Document",
        focused: false,
      })),
    }))).toThrow();

    expect(() => copilotTurnRequestSchema.parse(request({
      view: "history",
      agentId: null,
      conversationId: null,
      entities: [{ type: "agent", id: "agent-1", label: "x".repeat(121), focused: false }],
    }))).toThrow();

    expect(() => copilotTurnRequestSchema.parse(request({
      view: "history",
      agentId: null,
      conversationId: null,
      entities: Array.from({ length: 4 }, (_, index) => ({
        type: "agent",
        id: `agent-${index}`,
        label: "Agent",
        focused: true,
      })),
    }))).toThrow();
  });
});
