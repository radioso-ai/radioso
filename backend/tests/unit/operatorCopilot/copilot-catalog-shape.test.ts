import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/routines/public.js", () => ({
  routineToPortableDocument: vi.fn(),
}));

import { createAgentConfigurationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/chat.js";
import { createDocumentSearchCopilotTools } from "../../../src/modules/operatorCopilot/tools/documents.js";
import { createRoutineDefinitionCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";
import { buildDescriptors, dependencies } from "./copilot-tools-test-helpers.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

describe("copilot catalog shape", () => {
  it("classifies every family reader as a read", () => {
    expect(dependencies().descriptors.map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: "agent_configuration", shape: "read" },
      { name: "routine_definition", shape: "read" },
      { name: "conversation_transcript", shape: "read" },
      { name: "turn_trace", shape: "read" },
      { name: "conversation_history_search", shape: "read" },
      { name: "document_search", shape: "read" },
    ]);
  });

  it("marks single-entity US1 reads and leaves searches unlinked", () => {
    const agentService = { listExisting: vi.fn(), resolve: vi.fn() };
    const descriptors = [
      ...createAgentConfigurationCopilotTools({ agentService }),
      ...createRoutineDefinitionCopilotTools({ agentLookup: agentService, routineDefinitionService: { list: vi.fn(), get: vi.fn() } }),
      ...createChatCopilotTools({ chatHistoryService: { getConversation: vi.fn(), getConversationTurn: vi.fn(), listConversations: vi.fn() } }),
      ...createDocumentSearchCopilotTools({ documentSearchService: { search: vi.fn() } }),
    ];
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(byName.get("agent_configuration")?.describeEntity?.({}, context)).toEqual({ type: "agent", id: "agent-1" });
    expect(byName.get("routine_definition")?.describeEntity?.({ routineId: "routine-1" }, context)).toEqual({ type: "routine", id: "routine-1", agentId: "agent-1" });
    expect(byName.get("conversation_transcript")?.describeEntity?.({}, { ...context, pageContext: { ...context.pageContext, conversationId: "conversation-1" } })).toEqual({ type: "conversation", id: "conversation-1" });
    expect(byName.get("turn_trace")?.describeEntity).toBeUndefined();
    expect(byName.get("conversation_history_search")?.describeEntity).toBeUndefined();
    expect(byName.get("document_search")?.describeEntity).toBeUndefined();
  });

  it("declares the document status and agent skills readers with their required permissions", () => {
    const descriptors = buildDescriptors();

    expect(descriptors.map(({ name, requiredPermission, contributingModule, uiLabel, shape }) => ({ name, requiredPermission, contributingModule, uiLabel, shape }))).toEqual([
      {
        name: "document_status",
        requiredPermission: "workspace.documents.read",
        contributingModule: "documents",
        uiLabel: "Checking document status",
        shape: "read",
      },
      {
        name: "agent_skills",
        requiredPermission: "workspace.agents.read",
        contributingModule: "agentSkills",
        uiLabel: "Reading agent skills",
        shape: "read",
      },
    ]);
  });
});
