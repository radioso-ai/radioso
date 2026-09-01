import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/routines/public.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/modules/routines/public.js")>(),
  routineToPortableDocument: vi.fn(),
}));

import { createAgentConfigurationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";
import { createChatCopilotTools } from "../../../src/modules/operatorCopilot/tools/chat.js";
import { createDocumentSearchCopilotTools } from "../../../src/modules/operatorCopilot/tools/documents.js";
import { createRoutineDefinitionCopilotTools } from "../../../src/modules/operatorCopilot/tools/routines.js";
import { createCopilotToolDescriptors } from "../../../src/modules/operatorCopilot/tools/index.js";
import { copilotProposalTargetTypes } from "../../../src/modules/operatorCopilot/contracts.js";
import { createCopilotToolCatalog } from "../../../src/app/composition/copilotToolCatalog.js";
import { z } from "zod";
import { assertCopilotCapabilityProvenance } from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import { createOpenApiDocument } from "../../../src/app/http/openapi/openApiDocument.js";
import { operationPermissionRequirements } from "../../../src/app/http/openapi/operationPermissionRequirements.js";
import { agentCopilotPrimitives } from "../../../src/modules/agents/public.js";
import { agentSkillsCopilotPrimitives } from "../../../src/modules/agentSkills/public.js";
import { agentWizardCopilotPrimitives } from "../../../src/modules/agentWizard/public.js";
import { chatCopilotPrimitives } from "../../../src/modules/chat/public.js";
import { contextVariableCopilotPrimitives } from "../../../src/modules/context-variables/public.js";
import { documentCopilotPrimitives } from "../../../src/modules/documents/public.js";
import { embeddingProfileCopilotPrimitives } from "../../../src/modules/embeddingProfiles/public.js";
import { evalCopilotPrimitives } from "../../../src/modules/eval/public.js";
import { retrievalCopilotPrimitives } from "../../../src/modules/retrieval/public.js";
import { routineCopilotPrimitives } from "../../../src/modules/routines/public.js";
import { settingsCopilotPrimitives } from "../../../src/modules/settings/public.js";
import { websiteCrawlerCopilotPrimitives } from "../../../src/modules/websiteCrawler/public.js";
import { copilotResolvableToolPermissions, copilotToolPermissions } from "../../../src/modules/operatorCopilot/routes.js";
import { filterCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { AccountAccessService } from "../../../src/modules/account/services/accountAccessService.js";
import { copilotTriageSourcePermissions } from "../../../src/modules/operatorCopilot/tools/triage.js";
import { buildDescriptors, dependencies } from "./copilot-tools-test-helpers.js";
import { createAuditService, InMemoryAccountMembershipRepository } from "../../support/fakes.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

const ownerExportedPrimitiveIds = new Set([
  ...agentCopilotPrimitives,
  ...agentSkillsCopilotPrimitives,
  ...agentWizardCopilotPrimitives,
  ...chatCopilotPrimitives,
  ...contextVariableCopilotPrimitives,
  ...documentCopilotPrimitives,
  ...embeddingProfileCopilotPrimitives,
  ...evalCopilotPrimitives,
  ...retrievalCopilotPrimitives,
  ...routineCopilotPrimitives,
  ...settingsCopilotPrimitives,
  ...websiteCrawlerCopilotPrimitives,
]);

// These two exercise the REAL composition barrel rather than re-wiring the factories by hand.
// The other suites build descriptors factory-by-factory, which means they wire dependencies
// correctly themselves and can never catch the barrel wiring them wrongly — which is exactly how
// a dead tool and a dead name-resolution path both reached main.
const realCatalogDependencies = () => {
  const stub = () => vi.fn(async () => { throw new Error("not exercised: these tests only resolve entities"); });
  const agentService = {
    listExisting: vi.fn(async () => [{ id: "agent-1", name: "Support" }]),
    resolve: stub(),
    get: stub(),
  };
  return {
    agentService,
    routineDefinitionService: { list: stub(), get: stub(), validate: stub() },
    chatHistoryService: { getConversation: stub(), getConversationTurn: stub(), listConversations: stub() },
    documentSearchService: { search: stub() },
    documentChunks: { listPageForDocument: stub() },
    documentMaintenance: { reprocessDocument: stub(), reprocessSource: stub(), recrawlSource: stub() },
    documentStatusService: { summarize: stub() },
    evalResultsService: { listWithLatestRun: stub() },
    replyDraft: { draft: stub() },
    qualitySignalsService: { getQualityStats: stub(), listLowQualityTurns: stub() },
    qualityTriageService: { resolutionReasons: ["knowledge_gap"] as [string, ...string[]], setTriageState: stub() },
    retrievalProbe: { probe: stub() },
    audiencePulseService: { read: stub() },
    agentSkillsService: { list: stub() },
    skillCapabilityTargets: { list: stub() },
    contextVariables: { listByWorkspace: stub(), listByAgent: stub() },
    workspaceSettings: {
      getRetrievalDefaults: stub(), getIngestionSettings: stub(), listLlmModels: stub(),
      getProviderCredentialHealth: stub(), getGeneralSettings: stub(),
    },
    proposalRepository: { createProposal: stub() },
    proposalAdapters: copilotProposalTargetTypes.map((targetType) => ({
      targetType, draft: stub(), preview: stub(), applyIfVersionMatches: stub(), validatePayload: stub(),
    })),
    auditService: { record: stub() },
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "acme" },
  } as unknown as Parameters<typeof createCopilotToolCatalog>[0];
};

const realCatalog = () => createCopilotToolDescriptors(
  realCatalogDependencies() as unknown as Parameters<typeof createCopilotToolDescriptors>[0],
);

const contributedDescriptor = (overrides: Record<string, unknown> = {}) => ({
  name: "extension_usage",
  shape: "read" as const,
  verificationCost: () => 0,
  uiLabel: "Reading extension state",
  description: "Read extension state.",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["workspace.settings.read"] as const,
  contributingModule: "extension",
  dashboardSubject: { type: "workspace_settings" },
  capabilityProvenance: { backingOperationIds: ["getExtensionUsage"] },
  createTool: () => ({
    name: "extension_usage",
    description: "Read extension state.",
    inputSchema: z.object({}),
    outputSchema: z.object({ value: z.string() }),
    invoke: async () => ({ value: "extension" }),
  }),
  ...overrides,
});

describe("copilot catalog contributions through the real factory", () => {
  // The unit tests around resolveCopilotToolContributions pin the rules; this pins that production
  // assembly actually applies them, which is the half a fixture-only test cannot see.
  const assemble = (contribution: unknown) => createCopilotToolCatalog({
    ...realCatalogDependencies(),
    toolContributions: [contribution],
  } as unknown as Parameters<typeof createCopilotToolCatalog>[0]);

  it("assembles a contributed tool alongside the first-party catalog", async () => {
    const catalog = assemble({
      moduleId: "extension",
      descriptors: [contributedDescriptor()],
      operationPermissions: { getExtensionUsage: ["workspace.settings.read"] },
    });
    const contributed = catalog.find((descriptor) => descriptor.name === "extension_usage");

    expect(contributed).toBeDefined();
    // Enrichment is what gives a tool its dashboard handoff and its re-authorization checks; a
    // contribution merged after it would be governed but unreachable from the operator's page.
    const result = await contributed!.createTool({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      surface: "dashboard" as const,
      currentAuthorization: { hasAllPermissions: async () => true },
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    } as never).invoke({}, { signal: new AbortController().signal, stepIndex: 0, callId: "call-1" } as never);

    expect(result).toMatchObject({ value: "extension", dashboardUrl: "/w/acme/settings" });
    expect(copilotResolvableToolPermissions(catalog)).toContain("workspace.settings.read");
  });

  it("refuses a contributed tool that cites an identity nothing declares", () => {
    expect(() => assemble({ moduleId: "extension", descriptors: [contributedDescriptor()] }))
      .toThrow("Unknown public operation identity");
    expect(() => assemble({
      moduleId: "extension",
      descriptors: [contributedDescriptor({ capabilityProvenance: undefined })],
      operationPermissions: { getExtensionUsage: [] },
    })).toThrow("Missing capability provenance");
  });

  it("refuses a contributed tool that weakens the permissions its own operation requires", () => {
    expect(() => assemble({
      moduleId: "extension",
      descriptors: [contributedDescriptor()],
      operationPermissions: { getExtensionUsage: ["workspace.agents.manage"] },
    })).toThrow("weakens permission parity");
  });

  it("leaves the first-party provenance registry a bijection when a contribution is present", () => {
    // Running the registry check over the merged catalog would report every contributed descriptor
    // as ungoverned, which is the failure that would push EE identities into a first-party map.
    expect(() => assemble({
      moduleId: "extension",
      descriptors: [contributedDescriptor()],
      operationPermissions: { getExtensionUsage: ["workspace.settings.read"] },
    })).not.toThrow();
  });
});

describe("copilot catalog wiring", () => {
  it("evaluates every production descriptor for every supported workspace role and each missing permission vector", () => {
    const catalog = realCatalog();
    const candidatePermissions = [...new Set(catalog.flatMap((descriptor) => descriptor.requiredPermissions))];
    const access = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());
    const rolePermissions = (['member', 'admin', 'owner'] as const)
      .map((role) => access.permissionsForWorkspaceRole(role, candidatePermissions));

    for (const permissions of Object.values(rolePermissions)) {
      const visible = new Set(filterCopilotToolCatalog(catalog, permissions).map((descriptor) => descriptor.name));
      for (const descriptor of catalog) {
        expect(visible.has(descriptor.name)).toBe(descriptor.requiredPermissions.every((permission) => permissions.has(permission)));
      }
    }
    for (const descriptor of catalog) {
      for (const removed of descriptor.requiredPermissions) {
        const grant = new Set(descriptor.requiredPermissions.filter((permission) => permission !== removed));
        expect(filterCopilotToolCatalog([descriptor], grant)).toEqual([]);
      }
    }
  });

  it("gives every assembled production descriptor validated backing or reviewed Ray-only provenance", () => {
    const operationIds = new Set(Object.values(createOpenApiDocument().paths ?? {})
      .flatMap((path) => Object.values(path ?? {}))
      .flatMap((operation) => operation && typeof operation === "object" && "operationId" in operation && typeof operation.operationId === "string"
        ? [operation.operationId]
        : []));

    expect(() => assertCopilotCapabilityProvenance(realCatalog(), {
      publicOperationIds: operationIds,
      operationPermissions: operationPermissionRequirements,
      ownerExportedPrimitiveIds,
    })).not.toThrow();
    expect(realCatalog().every((descriptor) => descriptor.capabilityProvenance)).toBe(true);
  });
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

  it("contributes bounded document diagnosis, maintenance, and proposals through the real barrel", () => {
    expect(realCatalog()
      .filter((descriptor) => descriptor.contributingModule === "documents")
      .map(({ name, shape, requiredPermissions }) => ({ name, shape, requiredPermissions }))).toEqual([
      { name: "document_search", shape: "read", requiredPermissions: ["workspace.documents.read"] },
      { name: "document_status", shape: "read", requiredPermissions: ["workspace.documents.read"] },
      { name: "document_chunks", shape: "read", requiredPermissions: ["workspace.documents.read"] },
      { name: "reprocess_document", shape: "act", requiredPermissions: ["workspace.documents.manage"] },
      { name: "recrawl_source", shape: "act", requiredPermissions: ["workspace.documents.manage"] },
      { name: "propose_document", shape: "propose", requiredPermissions: ["workspace.documents.manage"] },
      { name: "propose_document_retrieval", shape: "propose", requiredPermissions: ["workspace.documents.manage"] },
      { name: "propose_document_removal", shape: "propose", requiredPermissions: ["workspace.documents.manage"] },
    ]);
  });

  it("resolves every permission the assembled catalog requires", () => {
    // A descriptor whose permission the route never resolves is filtered out of every live turn and
    // is unreachable in production, while unit tests that inject permissions directly still pass.
    // workspace_settings shipped dead this way. The per-turn set is now derived from the catalog,
    // so this pins the derivation rather than a hand-maintained list.
    const resolvable = new Set<string>(copilotResolvableToolPermissions(realCatalog()));
    const missing = realCatalog()
      .flatMap((descriptor) => descriptor.requiredPermissions
        .filter((permission) => !resolvable.has(permission))
        .map((permission) => `${descriptor.name} needs ${permission}`));

    expect(missing).toEqual([]);
    // The baseline stays a subset rather than being replaced: the triage digest gates sections on
    // permissions no descriptor requires, and dropping them would report those sections
    // unauthorized on every turn.
    expect(copilotToolPermissions.every((permission) => resolvable.has(permission))).toBe(true);
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
      // Validation is structural: no model budget, nothing persisted, safe to retry.
      { name: "validate_routine", shape: "read" },
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
      ...createRoutineDefinitionCopilotTools({ agentLookup: agentService, routineDefinitionService: { list: vi.fn(), get: vi.fn(), validate: vi.fn() } }),
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

describe("verification cost declarations", () => {
  // Cost is declared per descriptor rather than inferred from shape, because the two answer
  // different questions and inferring one from the other already shipped a hole: `run_eval_suite`
  // is an `act` (it moves a case's stored verdict) and was therefore exempt from a budget keyed on
  // `shape: "probe"` — while being the only tool that replays several cases in one call.
  const MODEL_SPENDING_TOOLS: Record<string, { input: unknown; expected: number }> = {
    test_agent_turn: { input: {}, expected: 1 },
    replay_eval_case: { input: {}, expected: 1 },
    retrieval_probe: { input: {}, expected: 1 },
    // One ephemeral turn over the live conversation, whatever its length.
    draft_reply: { input: {}, expected: 1 },
    // One completion over the crawled pages, whatever the site's size.
    analyze_website: { input: {}, expected: 1 },
    run_eval_suite: { input: { caseIds: ["a", "b", "a"] }, expected: 2 },
  };

  it("charges every tool that commands a synchronous model run", () => {
    const byName = new Map(realCatalog().map((descriptor) => [descriptor.name, descriptor]));

    for (const [name, { input, expected }] of Object.entries(MODEL_SPENDING_TOOLS)) {
      const descriptor = byName.get(name);
      expect(descriptor, `${name} is missing from the catalog`).toBeDefined();
      expect(descriptor!.verificationCost(input), `${name} declares no verification cost`).toBe(expected);
    }
  });

  it("leaves the rest of the catalog free, so a read is never rationed", () => {
    const free = realCatalog().filter((descriptor) => !(descriptor.name in MODEL_SPENDING_TOOLS));

    for (const descriptor of free) {
      expect(descriptor.verificationCost({}), `${descriptor.name} charges a budget it does not spend`).toBe(0);
    }
  });
});
