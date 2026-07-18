import {
  type AgentBudgets,
  type AgenticCapabilityRunner,
  type AgentTool,
  type AgentTraceEvent,
  type TerminatedReason,
} from "../../../shared/agent-runtime/index.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { QueryRewritePort } from "../domain/queryRewritePort.js";
import type { ActivityTrace } from "../domain/retrievalPipelineTypes.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import { normalizeVectorMetadataFilter } from "../domain/vectorFilter.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { VectorIndexPort } from "../domain/vectorIndex.js";
import type { ChunkCandidateHydratorPort } from "../infra/chunkCandidateHydrator.js";
import type { EmbeddingGateway } from "./embeddingService.js";
import type { RerankGateway } from "./rerankService.js";
import { buildAgenticActivityTrace } from "./agenticActivityTraceBuilder.js";
import {
  InMemoryChunkRegistry,
  createFetchChunkTool,
  createFinalizeTool,
  createLexicalSearchTool,
  createRerankTool,
  createRewriteQueryTool,
  createSemanticSearchTool,
  type ChunkRegistry,
  type FinalizedSelection,
  type RegisteredChunk,
} from "./agenticTools/index.js";

const DEFAULT_FALLBACK_CHUNK_LIMIT = 8;

export interface AgenticRetrievalRunnerDeps {
  readonly capabilityRunner: AgenticCapabilityRunner;
  readonly embeddings: EmbeddingGateway;
  readonly vectorIndex: VectorIndexPort;
  readonly chunkHydrator: ChunkCandidateHydratorPort;
  readonly lexicalSearch: LexicalSearchPort;
  readonly queryRewrite: QueryRewritePort;
  readonly rerankGateway: RerankGateway;
}

export interface AgenticRetrievalRunInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly systemPrompt: string;
  readonly sourceFilter?: RetrievalSourceFilter;
  /**
   * Caller-supplied metadata filter from the retrieval request. Threaded into
   * every search tool as a non-negotiable scope; the agent may narrow it via
   * its own metadataFilter argument but cannot remove or widen it.
   */
  readonly metadataFilter?: Record<string, unknown>;
  readonly workspaceContext?: LlmCapabilityResolveInput;
  readonly usageContext?: Omit<ModelCallUsageContext, "operation">;
  readonly budgets?: Partial<AgentBudgets>;
  readonly fallbackChunkLimit?: number;
  readonly embeddingModel?: string;
  readonly similarityThreshold?: number;
  readonly snippetChars?: number;
  readonly agenticToolFactories?: ReadonlyArray<AgenticRetrievalToolFactory>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface AgenticRetrievalToolFactoryContext {
  readonly registry: ChunkRegistry;
  readonly snippetChars?: number;
}

export type AgenticRetrievalToolFactory = (
  context: AgenticRetrievalToolFactoryContext,
) => ReadonlyArray<AgentTool>;

export interface AgenticRetrievalSearchStats {
  /** Distinct chunkIds surfaced across all semantic_search calls. */
  readonly semanticCandidateCount: number;
  /** Distinct chunkIds surfaced across all lexical_search calls. */
  readonly lexicalCandidateCount: number;
  /** Distinct chunkIds surfaced across both search tools combined. */
  readonly mergedCandidateCount: number;
  /** True if the agent invoked the rerank tool at least once. */
  readonly rerankInvoked: boolean;
}

export interface AgenticRetrievalRunResult {
  readonly selectedChunks: ReadonlyArray<RegisteredChunk>;
  readonly rationale: string | null;
  readonly trace: ActivityTrace;
  readonly terminatedReason: TerminatedReason;
  readonly stepsTaken: number;
  readonly searchStats: AgenticRetrievalSearchStats;
}

export class AgenticRetrievalRunner {
  constructor(private readonly deps: AgenticRetrievalRunnerDeps) {}

  async run(input: AgenticRetrievalRunInput): Promise<AgenticRetrievalRunResult> {
    const registry = new InMemoryChunkRegistry();
    let finalized: FinalizedSelection | null = null;
    const metadataFilter = normalizeVectorMetadataFilter(input.metadataFilter);

    const stagedTools = (input.agenticToolFactories ?? [])
      .flatMap((factory) => factory({ registry, snippetChars: input.snippetChars }));

    const tools: AgentTool[] = [
      createSemanticSearchTool({
        workspaceId: input.workspaceId,
        embeddings: this.deps.embeddings,
        vectorIndex: this.deps.vectorIndex,
        chunkHydrator: this.deps.chunkHydrator,
        registry,
        sourceFilter: input.sourceFilter,
        embeddingModel: input.embeddingModel,
        similarityThreshold: input.similarityThreshold,
        snippetChars: input.snippetChars,
        callerMetadataFilter: metadataFilter,
        usageContext: input.usageContext,
      }) as AgentTool,
      createLexicalSearchTool({
        workspaceId: input.workspaceId,
        lexicalSearch: this.deps.lexicalSearch,
        registry,
        sourceFilter: input.sourceFilter,
        snippetChars: input.snippetChars,
        callerMetadataFilter: metadataFilter,
      }) as AgentTool,
      createRewriteQueryTool({
        queryRewrite: this.deps.queryRewrite,
        workspaceContext: input.workspaceContext,
        usageContext: input.usageContext,
      }) as AgentTool,
      createRerankTool({
        rerankGateway: this.deps.rerankGateway,
        registry,
        workspaceContext: input.workspaceContext,
        usageContext: input.usageContext,
      }) as AgentTool,
      createFetchChunkTool({ registry }) as AgentTool,
      ...stagedTools,
      createFinalizeTool({
        registry,
        onFinalized: (selection) => {
          finalized = selection;
        },
      }) as AgentTool,
    ];

    const fallbackLimit = input.fallbackChunkLimit ?? DEFAULT_FALLBACK_CHUNK_LIMIT;
    const capabilityResult = await this.deps.capabilityRunner.run(
      {
        systemPrompt: input.systemPrompt,
        userMessage: input.query,
        signal: input.signal,
        now: input.now,
        usageContext: input.usageContext,
      },
      {
        tools,
        budgetProfile: input.budgets,
        getFinalization: () => finalized,
        mapFinalizationToSelection: (selection) => registry.resolve(selection.chunkIds),
        selectFallback: ({ events }) => computeFallbackSelection(events, registry, fallbackLimit),
        mapTrace: ({ events, runResult, selection, finalization, traceStartedAtMs, budgetProfile }) =>
          buildAgenticActivityTrace({
            events,
            runResult,
            selectedChunkIds: selection.map((chunk) => chunk.chunkId),
            finalRationale: finalization?.rationale ?? null,
            traceStartedAtMs,
            fallbackBudgets: budgetProfile,
          }),
      },
    );

    return {
      selectedChunks: capabilityResult.selection,
      rationale: capabilityResult.finalization?.rationale ?? null,
      trace: capabilityResult.trace,
      terminatedReason: capabilityResult.terminatedReason,
      stepsTaken: capabilityResult.stepsTaken,
      searchStats: computeSearchStats(capabilityResult.events),
    };
  }
}

const computeSearchStats = (events: ReadonlyArray<AgentTraceEvent>): AgenticRetrievalSearchStats => {
  const semantic = new Set<string>();
  const lexical = new Set<string>();
  let rerankInvoked = false;
  for (const event of events) {
    if (event.kind !== "tool_call_completed") {
      continue;
    }
    if (event.toolName === "rerank") {
      rerankInvoked = true;
      continue;
    }
    if (event.toolName !== "semantic_search" && event.toolName !== "lexical_search") {
      continue;
    }
    const output = event.output as { results?: Array<{ chunkId?: unknown }> } | null | undefined;
    const target = event.toolName === "semantic_search" ? semantic : lexical;
    for (const result of output?.results ?? []) {
      if (typeof result.chunkId === "string") {
        target.add(result.chunkId);
      }
    }
  }
  const merged = new Set<string>([...semantic, ...lexical]);
  return {
    semanticCandidateCount: semantic.size,
    lexicalCandidateCount: lexical.size,
    mergedCandidateCount: merged.size,
    rerankInvoked,
  };
};

const computeFallbackSelection = (
  events: ReadonlyArray<AgentTraceEvent>,
  registry: InMemoryChunkRegistry,
  limit: number,
): RegisteredChunk[] => {
  // Walk events in reverse, collecting chunkIds that the agent surfaced via
  // search tools, up to the limit. This gives the agent's most recently seen
  // results when it terminates by budget instead of finalize.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let i = events.length - 1; i >= 0 && ordered.length < limit; i -= 1) {
    const event = events[i];
    if (event.kind !== "tool_call_completed") {
      continue;
    }
    if (event.toolName !== "semantic_search" && event.toolName !== "lexical_search") {
      continue;
    }
    const output = event.output as { results?: Array<{ chunkId?: unknown }> } | null | undefined;
    const results = output?.results ?? [];
    for (const result of results) {
      const chunkId = typeof result.chunkId === "string" ? result.chunkId : null;
      if (!chunkId || seen.has(chunkId)) {
        continue;
      }
      seen.add(chunkId);
      ordered.push(chunkId);
      if (ordered.length >= limit) {
        break;
      }
    }
  }
  return registry.resolve(ordered);
};
