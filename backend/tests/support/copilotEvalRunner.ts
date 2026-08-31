/**
 * Runners for the Ray eval suite (issue #1054).
 *
 * {@link observeCopilotTurn} drives a real {@link OperatorCopilotService} turn and records what the
 * suite scores. Both fidelities share it, so a deterministic run and a live run observe the same
 * turn through the same code path — only the model behind `capabilityRunner` differs.
 *
 * The deterministic runner pairs it with a scripted model that replays the case's authored plan
 * against the real catalog. That is not a model-behaviour check; it is a *contract* check, and it
 * covers the failure modes that have actually reached main: a renamed tool, a tightened input
 * schema, and a descriptor requiring a permission the turn route never resolves.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  type AgentTraceEvent,
  type ModelToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";
import { validateAgentInput } from "../../src/modules/agents/public.js";
import { enrichCopilotToolCatalog } from "../../src/modules/operatorCopilot/catalog.js";
import { OperatorCopilotService } from "../../src/modules/operatorCopilot/public.js";
import { copilotProposalTargetTypes } from "../../src/modules/operatorCopilot/contracts.js";
import type {
  CopilotToolDescriptor,
  CopilotWorkspaceRouteKeyResolver,
} from "../../src/modules/operatorCopilot/contracts.js";
import { createCopilotToolDescriptors } from "../../src/modules/operatorCopilot/tools/index.js";
import { InMemoryCopilotRepository } from "./inMemoryCopilotRepository.js";
import type { CopilotRepositoryPort } from "../../src/modules/operatorCopilot/public.js";
import type {
  CopilotEvalCase,
  CopilotObservedProposal,
  CopilotObservedToolCall,
  CopilotObservedTurn,
} from "./copilotEvalSuite.js";

export const COPILOT_EVAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const COPILOT_EVAL_WORKSPACE_KEY = "sunny-co";
export const COPILOT_EVAL_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
export const COPILOT_EVAL_OPERATOR_ID = "33333333-3333-4333-8333-333333333333";
export const COPILOT_EVAL_AGENT_ID = "44444444-4444-4444-8444-444444444444";
export const COPILOT_EVAL_CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
export const COPILOT_EVAL_MESSAGE_ID = "66666666-6666-4666-8666-666666666666";
export const COPILOT_EVAL_DOCUMENT_ID = "77777777-7777-4777-8777-777777777771";
export const COPILOT_EVAL_ROUTINE_ID = "88888888-8888-4888-8888-888888888888";
/** Cases name the routine the way an operator would, so a live run substitutes the real name here. */
export const COPILOT_EVAL_ROUTINE_NAME = "Order status";

export const copilotSystemPrompt = (): string =>
  readFileSync(fileURLToPath(new URL("../../prompts/copilot/system.md", import.meta.url)), "utf8");

export const copilotEvalWorkspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver = {
  resolveWorkspaceKey: async () => COPILOT_EVAL_WORKSPACE_KEY,
};

/**
 * A model that plays back an authored tool plan, one call per step, then answers.
 *
 * It never inspects the tool catalog it is handed: an unknown or renamed tool has to reach the
 * runtime and come back as a rejection, because that rejection *is* the regression signal.
 */
export const scriptedToolCallingGateway = (
  plan: ReadonlyArray<{ tool: string; input: unknown }>,
  finalMessage: string,
): ModelToolCallingGateway => {
  let step = 0;
  return {
    async request() {
      const next = plan[step];
      step += 1;
      if (!next) return { assistantMessage: finalMessage, toolCalls: [] };
      return {
        assistantMessage: "",
        toolCalls: [{ callId: `scripted-${step}`, toolName: next.tool, rawArguments: JSON.stringify(next.input ?? {}) }],
      };
    },
  };
};

export interface CopilotTurnObservationDependencies {
  readonly prompt: string;
  readonly tools: ReadonlyArray<CopilotToolDescriptor>;
  readonly capabilityRunner: Pick<AgenticCapabilityRunner, "runStreaming">;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly workspaceId?: string;
  readonly accountId?: string;
  readonly operatorUserId?: string;
  /**
   * Where copilot conversations, messages, and proposals land. Defaults to memory for the
   * deterministic run; a live run passes the real repository, because the proposal tools write
   * through the composed one and a proposal keyed to an in-memory conversation id would not
   * satisfy the foreign key it is stored under.
   */
  readonly repository?: CopilotRepositoryPort;
}

const toolCallsFromTrace = (events: ReadonlyArray<AgentTraceEvent>): CopilotObservedToolCall[] => {
  const inputs = new Map<string, unknown>();
  const calls: CopilotObservedToolCall[] = [];
  for (const event of events) {
    if (event.kind === "tool_call_validated") inputs.set(event.callId, event.input);
    if (event.kind === "tool_call_completed") calls.push({ tool: event.toolName, input: inputs.get(event.callId) ?? null, status: "completed" });
    if (event.kind === "tool_call_failed") calls.push({ tool: event.toolName, input: inputs.get(event.callId) ?? null, status: "failed", detail: event.error });
    if (event.kind === "tool_call_rejected") calls.push({ tool: event.toolName, input: null, status: "rejected", detail: `${event.reason}: ${event.details}` });
  }
  return calls;
};

/**
 * Runs one case as a real copilot turn and reports what the suite scores.
 *
 * The capability runner is wrapped rather than replaced so the observation covers what the service
 * itself contributes — the assembled system prompt with its safety-boundary block, the page-context
 * turn input, and the permission-filtered catalog — instead of only what the model did with them.
 */
export const observeCopilotTurn = async (
  evalCase: CopilotEvalCase,
  deps: CopilotTurnObservationDependencies,
): Promise<CopilotObservedTurn> => {
  const workspaceId = deps.workspaceId ?? COPILOT_EVAL_WORKSPACE_ID;
  const accountId = deps.accountId ?? COPILOT_EVAL_ACCOUNT_ID;
  const operatorUserId = deps.operatorUserId ?? COPILOT_EVAL_OPERATOR_ID;

  const events: AgentTraceEvent[] = [];
  let systemPrompt = "";
  let userMessage = "";
  let exposedTools: string[] = [];
  const capabilityRunner: Pick<AgenticCapabilityRunner, "runStreaming"> = {
    runStreaming: (input, tools, budgets) => {
      systemPrompt = input.systemPrompt;
      userMessage = input.userMessage;
      exposedTools = tools.map((tool) => tool.name);
      const stream = deps.capabilityRunner.runStreaming(input, tools, budgets);
      return {
        events: (async function* () {
          for await (const event of stream.events) {
            events.push(event);
            yield event;
          }
        })(),
        result: stream.result,
      };
    },
  };

  const repository = deps.repository ?? new InMemoryCopilotRepository();
  const service = new OperatorCopilotService({
    repository,
    capabilityRunner,
    usageLimitPolicy: {
      reserveAnswer: async () => ({ commit: async () => {}, release: async () => {} }),
    } as unknown as OperatorCopilotServiceUsageLimitPolicy,
    auditService: { record: async () => {} },
    workspaceRouteKeyResolver: deps.workspaceRouteKeyResolver,
    prompt: deps.prompt,
    tools: deps.tools,
    currentAuthorization: {
      hasAllPermissions: async ({ requiredPermissions }) =>
        requiredPermissions.every((permission) => evalCase.permissions.includes(permission)),
    },
  });

  // History is seeded through the repository rather than passed to runTurn, because the bounded
  // prior transcript the service threads into the model is built from persisted messages. A case
  // that supplied history any other way would exercise a path production never takes.
  let conversationId: string | null = null;
  if (evalCase.history?.length) {
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: evalCase.history[0]!.content.slice(0, 120) });
    for (const message of evalCase.history) {
      await repository.createMessage({ conversationId: conversation.id, role: message.role, content: message.content });
    }
    conversationId = conversation.id;
  }

  const proposals: CopilotObservedProposal[] = [];
  let outcome: CopilotObservedTurn["outcome"] = "failed";
  let turnConversationId = conversationId;
  for await (const event of service.runTurn({
    surface: "dashboard", workspaceId,
    accountId,
    operatorUserId,
    conversationId,
    message: evalCase.message,
    pageContext: {
      view: evalCase.pageContext.view,
      agentId: evalCase.pageContext.agentId,
      conversationId: evalCase.pageContext.conversationId,
      selection: evalCase.pageContext.selection ?? null,
      entities: evalCase.pageContext.entities ?? [],
    },
    permissions: new Set(evalCase.permissions),
  })) {
    if (event.event === "conversation") turnConversationId = event.data.conversationId;
    if (event.event === "proposal") proposals.push({ targetType: event.data.targetType, targetLabel: event.data.targetLabel, summary: event.data.summary });
    if (event.event === "outcome") outcome = event.data.status;
  }
  const messages = turnConversationId ? await repository.listMessages({ conversationId: turnConversationId }) : [];

  return {
    systemPrompt,
    userMessage,
    exposedTools,
    toolCalls: toolCallsFromTrace(events),
    proposals,
    finalMessage: messages.filter((message) => message.role === "copilot").at(-1)?.content ?? null,
    outcome,
    conversationId: turnConversationId,
  };
};

type OperatorCopilotServiceUsageLimitPolicy = ConstructorParameters<typeof OperatorCopilotService>[0]["usageLimitPolicy"];

export const runCopilotEvalCaseDeterministically = async (evalCase: CopilotEvalCase): Promise<CopilotObservedTurn> => {
  const runtime = new DefaultAgentRuntime({
    gateway: scriptedToolCallingGateway(evalCase.plan, evalCase.finalMessage ?? "Scripted answer."),
  });
  return observeCopilotTurn(evalCase, {
    prompt: copilotSystemPrompt(),
    tools: copilotEvalToolCatalog(),
    capabilityRunner: new AgenticCapabilityRunner({ runtime }),
    workspaceRouteKeyResolver: copilotEvalWorkspaceRouteKeyResolver,
  });
};

/** The real composition barrel over fixture ports, enriched exactly as the HTTP transport does. */
export const copilotEvalToolCatalog = (): ReadonlyArray<CopilotToolDescriptor> =>
  enrichCopilotToolCatalog(createCopilotToolDescriptors(copilotEvalCatalogDependencies()), {
    resolveWorkspaceKey: async () => COPILOT_EVAL_WORKSPACE_KEY,
  });

const evalDate = (iso: string): Date => new Date(iso);
const REFERENCE_NOW = "2026-08-26T09:00:00.000Z";

const unusedPort = (name: string) => async () => {
  // Fixture ports the dataset never exercises stay loud. A silent empty result would let a case
  // "pass" while reading from a source that has no data behind it in this harness.
  throw new Error(`Copilot eval fixture has no data for ${name}; add it before a case depends on it.`);
};

const fixtureAgent = () => ({
  id: COPILOT_EVAL_AGENT_ID,
  workspaceId: COPILOT_EVAL_WORKSPACE_ID,
  ...validateAgentInput({
    name: "Support",
    customInstruction: "Answer from the workspace knowledge base and never guess a price.",
  }),
  authoredDirectives: [{
    id: "77777777-7777-4777-8777-777777777777",
    agentId: COPILOT_EVAL_AGENT_ID,
    name: "Do not guess",
    condition: { kind: "always" as const },
    action: "Say when the available evidence is insufficient.",
    priority: 50,
    requiredCapabilities: [],
    dependsOn: [],
    excludes: [],
    routes: [],
    tags: [],
    description: null,
    binding: null,
    lifecycle: null,
    metadata: {},
    createdAt: evalDate("2026-08-01T10:00:00.000Z"),
    updatedAt: evalDate("2026-08-01T10:00:00.000Z"),
  }],
  createdAt: evalDate("2026-08-01T10:00:00.000Z"),
  updatedAt: evalDate("2026-08-01T10:00:00.000Z"),
});

const fixtureUserMessage = () => ({
  id: "88888888-8888-4888-8888-888888888888",
  role: "user" as const,
  source: "end_user",
  content: "How much is shipping to Italy?",
  createdAt: "2026-08-26T07:30:00.000Z",
});

const fixtureAssistantMessage = () => ({
  id: COPILOT_EVAL_MESSAGE_ID,
  role: "assistant" as const,
  source: "assistant",
  content: "Shipping to Italy is nine euro.",
  createdAt: "2026-08-26T07:30:05.000Z",
  citations: [],
  answerFeedbackEntries: [{ value: "down", comment: "That price is wrong.", updatedAt: "2026-08-26T07:40:00.000Z" }],
  latencyMs: 1_800,
  debug: {
    eventStatus: "success",
    recordedAt: "2026-08-26T07:30:05.000Z",
    stream: false,
    citationCount: 0,
    answerOutcome: "answered",
    route: "retrieval",
    activitySummary: null,
    activityTrace: null,
    turnTrace: { stages: [{ name: "retrieval_fanout", contextCount: 0 }] },
    errorMessage: null,
  },
});

const fixtureRoutine = () => ({
  id: COPILOT_EVAL_ROUTINE_ID,
  agentId: COPILOT_EVAL_AGENT_ID,
  lineageId: "99999999-9999-4999-8999-999999999999",
  version: 1,
  status: "draft" as const,
  name: COPILOT_EVAL_ROUTINE_NAME,
  activation: { triggerDescription: "When a customer asks where their order is", gateRef: null, priority: 10, reentryMode: "always" as const },
  slots: [],
  steps: [{ stableStepId: "ask_order_number", kind: "chat" as const, instruction: "Ask for the order number.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_order_number", toRef: "done", guardKind: "default" as const, guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete" as const, instruction: "Give the status.", ordinal: 0 }],
  createdAt: evalDate("2026-08-20T09:00:00.000Z"),
  updatedAt: evalDate("2026-08-25T09:00:00.000Z"),
});

const fixtureConversationSummaries = () => [{
  id: COPILOT_EVAL_CONVERSATION_ID,
  agentId: COPILOT_EVAL_AGENT_ID,
  agentName: "Support",
  preview: "I still have not had an answer about my refund.",
  createdAt: "2026-08-26T07:30:00.000Z",
  updatedAt: "2026-08-26T08:10:00.000Z",
  ownership: {
    state: "human_owned",
    ownerDisplayName: null,
    reason: "customer_requested_human",
    takenOverAt: null,
    updatedAt: "2026-08-26T07:45:00.000Z",
  },
}];

/**
 * Fixture ports for the real catalog barrel. Each returns the smallest shape its port declares, so
 * the deterministic run exercises real projection and payload-bounding code rather than a stub.
 */
export const copilotEvalCatalogDependencies = (): Parameters<typeof createCopilotToolDescriptors>[0] => {
  const agent = fixtureAgent();
  return {
    agentService: {
      listExisting: async () => [{ id: agent.id, name: agent.name, isDefault: true, assistantBootstrapActive: false }],
      resolve: async () => agent,
      get: async () => agent,
    },
    routineDefinitionService: {
      list: async () => [fixtureRoutine()],
      get: async () => fixtureRoutine(),
      validate: async () => ({ ok: true, diagnostics: [] }),
    },
    chatHistoryService: {
      getConversation: async () => ({
        conversationId: COPILOT_EVAL_CONVERSATION_ID,
        agentId: COPILOT_EVAL_AGENT_ID,
        agentName: "Support",
        sourceChannel: "web",
        createdAt: "2026-08-26T07:30:00.000Z",
        updatedAt: "2026-08-26T08:10:00.000Z",
        messageCount: 2,
        messages: [fixtureUserMessage(), fixtureAssistantMessage()],
      }),
      getConversationTurn: async () => ({
        conversationId: COPILOT_EVAL_CONVERSATION_ID,
        message: fixtureAssistantMessage(),
      }),
      listConversations: async () => ({ conversations: fixtureConversationSummaries(), total: 1 }),
    },
    documentSearchService: { search: async () => ({ results: [{ id: COPILOT_EVAL_DOCUMENT_ID, title: "Shipping rates", status: "processed" }] }) },
    documentChunks: {
      listPageForDocument: async () => ({
        chunks: [{
          id: "77777777-7777-4777-8777-777777777772",
          documentId: COPILOT_EVAL_DOCUMENT_ID,
          workspaceId: COPILOT_EVAL_WORKSPACE_ID,
          chunkIndex: 0,
          content: "Shipping to Italy costs nine euro.",
          searchText: "shipping italy nine euro",
          startOffset: 0,
          endOffset: 34,
          metadata: { heading: "Europe" },
          dateFrom: null,
          dateTo: null,
          createdAt: evalDate("2026-08-25T12:00:00.000Z"),
          embeddingDimensions: 1536,
        }],
        totalChunks: 1,
        nextChunkIndex: null,
      }),
    },
    documentMaintenance: {
      reprocessDocument: async ({ documentId }: { documentId: string }) => ({
        documentId,
        status: "queued" as const,
        queuedDocumentCount: 1,
        skippedDocumentCount: 0,
      }),
      reprocessSource: unusedPort("documentMaintenance.reprocessSource"),
      recrawlSource: unusedPort("documentMaintenance.recrawlSource"),
    },
    documentStatusService: {
      summarizeWorkspace: async () => ({ documentCount: 12, readyDocumentCount: 10, pendingDocumentCount: 1, failedDocumentCount: 1 }),
      listByStatuses: async () => [{ id: "99999999-9999-4999-8999-999999999999", title: "Shipping rates", status: "failed", failureReason: "parser_timeout", updatedAt: evalDate("2026-08-25T12:00:00.000Z"), sourceId: null }],
    },
    documentSourceStatusService: {
      summarizeSourcesForWorkspace: async () => ({ sources: [{ id: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "website", name: "sunny.example", lastSyncStatus: "failed", lastSyncedAt: evalDate("2026-08-25T06:00:00.000Z"), documentCount: 8 }], documentsWithoutSourceCount: 0 }),
    },
    evalResultsService: {
      listWithLatestRun: async () => [{
        id: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Shipping price",
        status: "fail" as const,
        updatedAt: "2026-08-25T09:00:00.000Z",
        agent: { agentId: COPILOT_EVAL_AGENT_ID, name: "Support" },
        latestRun: { startedAt: "2026-08-25T09:00:00.000Z", completedAt: "2026-08-25T09:00:20.000Z" },
      }],
    },
    qualitySignalsService: {
      getQualityStats: async () => ({ backlog: { negative_feedback: 3 } }),
      listLowQualityTurns: async () => ({
        items: [{
          assistantMessageId: COPILOT_EVAL_MESSAGE_ID,
          conversationId: COPILOT_EVAL_CONVERSATION_ID,
          agentId: COPILOT_EVAL_AGENT_ID,
          agentName: "Support",
          question: "How much is shipping to Italy?",
          answerPreview: "Shipping to Italy is nine euro.",
          createdAt: "2026-08-26T07:30:05.000Z",
          feedback: { downCount: 1, latestDownUpdatedAt: "2026-08-26T07:40:00.000Z", comments: [{ value: "down", comment: "That price is wrong.", updatedAt: "2026-08-26T07:40:00.000Z" }] },
        }],
        total: 1,
      }),
    },
    pendingApprovals: {
      listPending: async () => [{ conversationId: COPILOT_EVAL_CONVERSATION_ID, agentId: COPILOT_EVAL_AGENT_ID, reason: "refund_over_limit", createdAt: evalDate("2026-08-26T08:00:00.000Z") }],
    },
    audiencePulseService: { read: unusedPort("audiencePulseService.read") },
    agentSkillsService: { list: async () => [] },
    skillCapabilityRegistry: { list: () => [] },
    contextVariables: { listByWorkspace: async () => [], listByAgent: async () => [] },
    workspaceSettings: {
      getRetrievalDefaults: async () => ({}),
      getIngestionSettings: async () => ({}),
      listLlmModels: async () => [],
      getProviderCredentialHealth: async () => ({}),
      getGeneralSettings: async () => ({}),
    },
    agentTurnProbe: { run: unusedPort("agentTurnProbe.run") },
    retrievalProbe: {
      probe: async ({ agentId }: { agentId: string }) => ({
        agentId,
        retrievalEnabled: true,
        rewrittenQuery: { semantic: "shipping rates italy", lexical: "shipping italy" },
        results: [{
          documentId: COPILOT_EVAL_DOCUMENT_ID,
          chunkId: "77777777-7777-4777-8777-777777777772",
          title: "Shipping rates",
          content: "Shipping to Italy costs nine euro.",
          score: 0.71,
        }],
      }),
    },
    evalCaseCapture: { capture: unusedPort("evalCaseCapture.capture") },
    evalSuiteProbe: { run: unusedPort("evalSuiteProbe.run") },
    evalCaseReplay: { replay: unusedPort("evalCaseReplay.replay") },
    proposalEvidence: {
      evidence: { findByIds: async () => [] },
      agentVersion: { get: async () => agent },
    },
    proposalRepository: {
      createProposal: async (input: { targetType: string }) => ({
        id: "ccccccc1-cccc-4ccc-8ccc-cccccccccccc",
        messageId: null,
        status: "pending" as const,
        appliedRef: null,
        reason: null,
        createdAt: evalDate(REFERENCE_NOW),
        updatedAt: evalDate(REFERENCE_NOW),
        ...input,
      }),
    },
    proposalAdapters: copilotProposalTargetTypes.map((targetType) => ({
      targetType,
      draft: async (_workspaceId: string, _targetRef: unknown, intent: string) => ({
        payload: { intent },
        targetLabel: "Support",
        summary: `Draft ${targetType}: ${intent.slice(0, 60)}`,
        diagnostics: [],
      }),
      draftEdit: async (_workspaceId: string, _targetRef: unknown, changes: unknown) => ({
        payload: { kind: "edit", name: "Order status", changes },
        targetLabel: "Order status",
        summary: "Edit routine Order status.",
        diagnostics: [],
      }),
      draftLifecycle: async (_workspaceId: string, _targetRef: unknown, action: string) => ({
        payload: { kind: "lifecycle", action, name: "Order status" },
        targetLabel: "Order status",
        summary: `${action} routine Order status.`,
        diagnostics: [],
      }),
      preview: async () => ({ targetLabel: "Support", current: null, proposed: {} }),
      readVersionToken: async () => "v1",
      applyIfVersionMatches: async () => ({ outcome: "applied" as const, appliedRef: null }),
    })),
    workspaceRouteKeyResolver: copilotEvalWorkspaceRouteKeyResolver,
    auditService: { record: async () => {} },
  } as unknown as Parameters<typeof createCopilotToolDescriptors>[0];
};
