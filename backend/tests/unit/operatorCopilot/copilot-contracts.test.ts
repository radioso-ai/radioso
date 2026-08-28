import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { copilotPageEntityTypes, copilotTurnRequestSchema } from "../../../src/modules/operatorCopilot/public.js";

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

describe("copilot page entity type parity with the frontend client", () => {
  // frontend/lib/api-copilot.ts is a separate pnpm workspace package (Next.js) with no shared
  // contract package or codegen bridge for this hand-rolled fetch client, so this test reads its
  // source text directly rather than importing it. This is the same class of bug that shipped
  // twice before on CopilotProposalTargetType: a client-side enum and its runtime counterpart
  // drifted apart silently. See the comment on copilotPageEntityTypes in contracts.ts.
  const readFrontendPageEntityTypes = (): string[] => {
    const frontendSourcePath = new URL("../../../../frontend/lib/api-copilot.ts", import.meta.url);
    const frontendSource = readFileSync(frontendSourcePath, "utf8");
    const match = frontendSource.match(/export const COPILOT_PAGE_ENTITY_TYPES = \[([^\]]*)\] as const/);
    if (!match) {
      throw new Error(
        "Could not find COPILOT_PAGE_ENTITY_TYPES in frontend/lib/api-copilot.ts. " +
        "Update this test's extraction if the declaration moved or was renamed.",
      );
    }
    return [...match[1].matchAll(/'([^']+)'/g)].map((entityTypeMatch) => entityTypeMatch[1]);
  };

  it("accepts exactly the page entity types the frontend client type can produce", () => {
    const frontendEntityTypes = readFrontendPageEntityTypes();
    expect(frontendEntityTypes.length).toBeGreaterThan(0);
    expect([...frontendEntityTypes].sort()).toEqual([...copilotPageEntityTypes].sort());
  });

  it("rejects a page entity type the frontend contract does not declare", () => {
    expect(() => copilotTurnRequestSchema.parse(request({
      view: "agent",
      agentId: null,
      conversationId: null,
      entities: [{ type: "agent_skill", id: "skill-1", label: "Skill", focused: false }],
    }))).toThrow();
  });
});
