import {
  AGENT_BUDGET_DEFAULTS,
  type AgentBudgets,
  type AgentRuntime,
  type AgentTool,
  type AgentTraceEvent,
  type TerminatedReason,
  type TraceSink,
} from "../../../shared/agent-runtime/index.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { QueryRewritePort } from "../domain/queryRewritePort.js";
import type { ActivityTrace } from "../domain/retrievalPipelineTypes.js";
import type { RetrievalSourceFilter } from "../domain/retrievalSourceFilter.js";
import type { LexicalSearchPort } from "../infra/lexicalSearch.js";
import type { VectorSearchPort } from "../domain/vectorSearch.js";
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
  type FinalizedSelection,
  type RegisteredChunk,
} from "./agenticTools/index.js";

const DEFAULT_FALLBACK_CHUNK_LIMIT = 8;

export interface AgenticRetrievalRunnerDeps {
  readonly runtime: AgentRuntime;
  readonly embeddings: EmbeddingGateway;
  readonly vectorSearch: VectorSearchPort;
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
  readonly budgets?: Partial<AgentBudgets>;
  readonly fallbackChunkLimit?: number;
  readonly embeddingModel?: string;
  readonly similarityThreshold?: number;
  readonly snippetChars?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

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

// `?? default` does not catch NaN (NaN is neither null nor undefined), and a
// NaN budget makes `stepIndex >= NaN` always false → an unbounded loop. Treat
// any non-positive or non-finite override as absent and fall back to default.
const positiveOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const resolveBudgets = (overrides?: Partial<AgentBudgets>): AgentBudgets => ({
  maxSteps: positiveOr(overrides?.maxSteps, AGENT_BUDGET_DEFAULTS.maxSteps),
  maxToolResultTokens: positiveOr(overrides?.maxToolResultTokens, AGENT_BUDGET_DEFAULTS.maxToolResultTokens),
  maxWallTimeMs: positiveOr(overrides?.maxWallTimeMs, AGENT_BUDGET_DEFAULTS.maxWallTimeMs),
});

export class AgenticRetrievalRunner {
  constructor(private readonly deps: AgenticRetrievalRunnerDeps) {}

  async run(input: AgenticRetrievalRunInput): Promise<AgenticRetrievalRunResult> {
    const registry = new InMemoryChunkRegistry();
    let finalized: FinalizedSelection | null = null;

    const tools: AgentTool[] = [
      createSemanticSearchTool({
        workspaceId: input.workspaceId,
        embeddings: this.deps.embeddings,
        vectorSearch: this.deps.vectorSearch,
        registry,
        sourceFilter: input.sourceFilter,
        embeddingModel: input.embeddingModel,
        similarityThreshold: input.similarityThreshold,
        snippetChars: input.snippetChars,
        callerMetadataFilter: input.metadataFilter,
      }) as AgentTool,
      createLexicalSearchTool({
        workspaceId: input.workspaceId,
        lexicalSearch: this.deps.lexicalSearch,
        registry,
        sourceFilter: input.sourceFilter,
        snippetChars: input.snippetChars,
        callerMetadataFilter: input.metadataFilter,
      }) as AgentTool,
      createRewriteQueryTool({
        queryRewrite: this.deps.queryRewrite,
        workspaceContext: input.workspaceContext,
      }) as AgentTool,
      createRerankTool({
        rerankGateway: this.deps.rerankGateway,
        registry,
        workspaceContext: input.workspaceContext,
      }) as AgentTool,
      createFetchChunkTool({ registry }) as AgentTool,
      createFinalizeTool({
        registry,
        onFinalized: (selection) => {
          finalized = selection;
        },
      }) as AgentTool,
    ];

    const events: AgentTraceEvent[] = [];
    const sink: TraceSink = {
      emit: (event) => {
        events.push(event);
      },
    };

    const budgets = resolveBudgets(input.budgets);
    const now = input.now ?? (() => Date.now());
    const traceStartedAtMs = now();

    const runResult = await this.deps.runtime.run(
      { systemPrompt: input.systemPrompt, userMessage: input.query },
      tools,
      budgets,
      {
        signal: input.signal,
        traceSink: sink,
        now: input.now,
      },
    );

    const fallbackLimit = input.fallbackChunkLimit ?? DEFAULT_FALLBACK_CHUNK_LIMIT;
    const finalizedSelection = finalized as FinalizedSelection | null;
    const selectedChunks: RegisteredChunk[] = finalizedSelection
      ? registry.resolve(finalizedSelection.chunkIds)
      : computeFallbackSelection(events, registry, fallbackLimit);
    const rationale = finalizedSelection?.rationale ?? null;

    const trace = buildAgenticActivityTrace({
      events,
      runResult,
      selectedChunkIds: selectedChunks.map((chunk) => chunk.chunkId),
      finalRationale: rationale,
      traceStartedAtMs,
      fallbackBudgets: budgets,
    });

    return {
      selectedChunks,
      rationale,
      trace,
      terminatedReason: runResult.terminatedReason,
      stepsTaken: runResult.stepsTaken,
      searchStats: computeSearchStats(events),
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
