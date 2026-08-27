import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/routines/public.js", () => ({
  routineToPortableDocument: vi.fn(),
}));

import { createAgentConfigurationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/chat.js";
import { createDocumentSearchCopilotTools } from "../../../src/modules/operatorCopilot/tools/documents.js";
import { createRoutineDefinitionCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";
import { createCopilotToolDescriptors } from "../../../src/modules/operatorCopilot/tools/index.js";
import { copilotToolPermissions } from "../../../src/modules/operatorCopilot/routes.js";
import { copilotTriageSourcePermissions } from "../../../src/modules/operatorCopilot/tools/triage.js";
import { buildDescriptors, dependencies } from "./copilot-tools-test-helpers.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

// These two exercise the REAL composition barrel rather than re-wiring the factories by hand.
// The other suites build descriptors factory-by-factory, which means they wire dependencies
// correctly themselves and can never catch the barrel wiring them wrongly — which is exactly how
// a dead tool and a dead name-resolution path both reached main.
const realCatalog = () => {
  const stub = () => vi.fn(async () => { throw new Error("not exercised: these tests only resolve entities"); });
  const agentService = {
    listExisting: vi.fn(async () => [{ id: "agent-1", name: "Support" }]),
    resolve: stub(),
    get: stub(),
  };
  return createCopilotToolDescriptors({
    agentService,
    routineDefinitionService: { list: stub(), get: stub() },
    chatHistoryService: { getConversation: stub(), getConversationTurn: stub(), listConversations: stub() },
    documentSearchService: { search: stub() },
    documentStatusService: { summarize: stub() },
    evalResultsService: { listWithLatestRun: stub() },
    qualitySignalsService: { getQualityStats: stub(), listLowQualityTurns: stub() },
    audiencePulseService: { read: stub() },
    agentSkillsService: { list: stub() },
    skillCapabilityTargets: { list: stub() },
    contextVariables: { listByWorkspace: stub(), listByAgent: stub() },
    workspaceSettings: {
      getRetrievalDefaults: stub(), getIngestionSettings: stub(), listLlmModels: stub(),
      getProviderCredentialHealth: stub(), getGeneralSettings: stub(),
    },
    proposalRepository: { createProposal: stub() },
    proposalAdapters: (["directive", "agent_setting", "routine", "agent_skill", "context_variable"] as const).map((targetType) => ({
      targetType, draft: stub(), preview: stub(), applyIfVersionMatches: stub(), validatePayload: stub(),
    })),
    auditService: { record: stub() },
  } as unknown as Parameters<typeof createCopilotToolDescriptors>[0]);
};

describe("copilot catalog wiring", () => {
  it("contributes the agent-turn probe through the real composition barrel", () => {
    expect(realCatalog().find((descriptor) => descriptor.name === "test_agent_turn")).toMatchObject({
      shape: "probe",
      requiredPermissions: [
        "workspace.agents.read",
        "workspace.chat.use",
        "workspace.history.read",
        "workspace.agents.manage",
      ],
    });
  });

  it("contributes the eval reader and its verification tools through the real barrel", () => {
    expect(realCatalog()
      .filter((descriptor) => descriptor.contributingModule === "eval")
      .map(({ name, shape }) => ({ name, shape }))).toEqual([
      { name: "eval_results", shape: "read" },
      { name: "create_eval_case_from_turn", shape: "act" },
      { name: "run_eval_suite", shape: "act" },
      { name: "replay_eval_case", shape: "probe" },
    ]);
  });

  it("requires only permissions the turn route actually resolves", () => {
    // A descriptor whose permission is missing from the route's list is filtered out of every
    // live turn and is unreachable in production, while unit tests that inject permissions
    // directly still pass. workspace_settings shipped dead this way.
    const missing = realCatalog()
      .flatMap((descriptor) => descriptor.requiredPermissions
        .filter((permission) => !(copilotToolPermissions as ReadonlyArray<string>).includes(permission))
        .map((permission) => `${descriptor.name} needs ${permission}`));

    expect(missing).toEqual([]);
  });

  it("resolves every permission the triage digest gates a section on", () => {
    // The digest's sections are gated inside the tool, so a permission missing from the route's
    // list does not hide the tool — it reports that section as unauthorized on every turn, for
    // every operator. That reads as a boundary rather than as the wiring gap it is.
    const missing = Object.values(copilotTriageSourcePermissions)
      .filter((permission) => !(copilotToolPermissions as ReadonlyArray<string>).includes(permission));

    expect(missing).toEqual([]);
  });

  it("gives every name-resolving descriptor the agent lookup it needs", async () => {
    // agentLookup is optional on the factories, so omitting it in the barrel is not a type error:
    // describeEntity just returns not_found for every name. Tools advertising agentName silently
    // stopped resolving "show eval results for Support" this way.
    const unresolved: string[] = [];
    for (const descriptor of realCatalog()) {
      const shape = (descriptor.inputSchema as { shape?: Record<string, unknown> }).shape;
      if (!shape?.agentName || !descriptor.describeEntity) continue;
      const described = await descriptor.describeEntity({ agentName: "Support" }, context);
      if (described && "kind" in described && described.kind === "not_found") unresolved.push(descriptor.name);
    }

    expect(unresolved).toEqual([]);
  });
});

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

    expect(descriptors.map(({ name, requiredPermissions, contributingModule, uiLabel, shape }) => ({ name, requiredPermissions, contributingModule, uiLabel, shape }))).toEqual([
      {
        name: "document_status",
        requiredPermissions: ["workspace.documents.read"],
        contributingModule: "documents",
        uiLabel: "Checking document status",
        shape: "read",
      },
      {
        name: "agent_skills",
        requiredPermissions: ["workspace.agents.read"],
        contributingModule: "agentSkills",
        uiLabel: "Reading agent skills",
        shape: "read",
      },
    ]);
  });
});
