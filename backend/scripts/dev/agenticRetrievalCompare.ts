/**
 * DEVELOPMENT TOOL. Not part of any production build, not invoked at runtime,
 * not compiled into `dist/` (tsconfig includes only `src/` and `tests/`).
 * Lives under `backend/scripts/dev/` to keep it visibly separate from
 * build-time codegen scripts in `backend/scripts/`.
 *
 * Comparison harness: run a fixed set of queries through both the deterministic
 * and agentic pipelines, capture answer, latency, and token usage, then emit a
 * side-by-side report.
 *
 * Usage:
 *   cd backend && pnpm exec tsx scripts/dev/agenticRetrievalCompare.ts \
 *     --workspace-id <uuid> \
 *     [--report-path comparison.md]
 *
 * Env: same as agenticRetrievalSmoke.ts (DATABASE_URL + LLM provider).
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { Database } from "../../src/shared/infra/database.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../src/shared/infra/llm/providerRegistry.js";
import { AgenticCapabilityRunner, DefaultAgentRuntime } from "../../src/shared/agent-runtime/index.js";
import {
  AgenticRetrievalPipelineService,
  AgenticRetrievalRunner,
  CandidatePreparationService,
  ConversationContextService,
  EmbeddingService,
  GatewayQueryRewritePortAdapter,
  PostgresChunkCandidateHydrator,
  PgLexicalSearch,
  PgVectorIndex,
  PromptBuilder,
  PromptContextSelectorService,
  QueryRewriteService,
  RerankService,
  RetrievalExecutionTelemetryService,
  RetrievalPipelineService,
} from "../../src/modules/retrieval/composition.js";
import type {
  RetrievalPipelineRequest,
  RetrievalPipelineResult,
} from "../../src/modules/retrieval/composition.js";
import { freezeRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/contracts/retrieval.js";
import type { RetrievalSettingsRecord } from "../../src/modules/settings/contracts/retrieval.js";
import type { RetrievalSettingsService } from "../../src/modules/settings/contracts/services.js";
import type { TelemetryService } from "../../src/shared/observability/telemetry/telemetryService.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type {
  TextGenerationClient,
  TextGenerationRequest,
} from "../../src/shared/infra/llm/providerTypes.js";

interface CliArgs {
  workspaceId: string;
  reportPath?: string;
  runs: number;
}

const parsePositiveInt = (raw: string | undefined, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    process.stderr.write(`${flag} expects a positive integer, got: ${String(raw)}\n`);
    process.exit(1);
  }
  return value;
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: Partial<CliArgs> & { runs?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace-id") args.workspaceId = argv[++i];
    else if (arg === "--report-path") args.reportPath = argv[++i];
    else if (arg === "--runs") args.runs = parsePositiveInt(argv[++i], "--runs");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: pnpm exec tsx scripts/dev/agenticRetrievalCompare.ts --workspace-id <uuid> [--runs N] [--report-path comparison.md]\n",
      );
      process.exit(0);
    }
  }
  if (!args.workspaceId) {
    process.stderr.write("Missing --workspace-id\n");
    process.exit(1);
  }
  return { workspaceId: args.workspaceId, reportPath: args.reportPath, runs: args.runs ?? 1 };
};

interface QueryCase {
  id: string;
  query: string;
  followUpToId?: string;
}

const QUERIES: QueryCase[] = [
  { id: "1", query: "Who is Arya?" },
  { id: "2", query: "Tell me about kriya courses in July." },
  { id: "2.1", query: "tell me the cost of the first course", followUpToId: "2" },
  { id: "3", query: "What is airplane route?" },
  { id: "4", query: "Did Narayani write books?" },
  { id: "4.1", query: "can you find how much her book costs", followUpToId: "4" },
  { id: "5", query: "When was ananda started and by whom?" },
];

// Approximate tokens-per-byte for crude cost comparison. Real provider tokenizers
// vary by model; we want a like-for-like ratio between pipelines, not absolute truth.
const APPROX_TOKEN_BYTES = 4;
const estimateTokens = (chars: number): number => Math.ceil(chars / APPROX_TOKEN_BYTES);

interface UsageCounter {
  inputChars: number;
  outputChars: number;
  callCount: number;
}

const newCounter = (): UsageCounter => ({ inputChars: 0, outputChars: 0, callCount: 0 });
const resetCounter = (c: UsageCounter): void => {
  c.inputChars = 0;
  c.outputChars = 0;
  c.callCount = 0;
};

const wrapClientWithCounter = (inner: TextGenerationClient, counter: UsageCounter): TextGenerationClient => ({
  get metadata() {
    return inner.metadata;
  },
  async complete(input: TextGenerationRequest): Promise<string> {
    counter.inputChars += (input.prompt?.length ?? 0) + (input.systemPrompt?.length ?? 0);
    counter.callCount += 1;
    const result = await inner.complete(input);
    counter.outputChars += result.length;
    return result;
  },
  async *stream(input: TextGenerationRequest): AsyncIterable<string> {
    counter.inputChars += (input.prompt?.length ?? 0) + (input.systemPrompt?.length ?? 0);
    counter.callCount += 1;
    for await (const chunk of inner.stream(input)) {
      counter.outputChars += chunk.length;
      yield chunk;
    }
  },
});

/**
 * Wraps every text client the registry produces with a shared counter so we can
 * compare *total* LLM I/O across both pipelines — including rewrite/rerank
 * inside the deterministic pipeline and per-step tool-calling inside the
 * agentic pipeline. Uses a monkey-patch because the registry's text-client
 * factory is private; acceptable for a one-off comparison tool.
 */
const buildCountingRegistry = (
  llmConfig: ReturnType<typeof resolveLlmConfig>,
): { registry: LlmProviderRegistry; counter: UsageCounter } => {
  const counter = newCounter();
  const registry = new LlmProviderRegistry(llmConfig);
  const internal = registry as unknown as {
    createTextClient: (config: unknown) => TextGenerationClient;
  };
  const original = internal.createTextClient.bind(registry);
  internal.createTextClient = (config: unknown) => wrapClientWithCounter(original(config), counter);
  return { registry, counter };
};

interface RunOutcome {
  pipeline: "deterministic" | "agentic";
  queryId: string;
  query: string;
  wallTimeMs: number;
  tokenEstimate: number;
  llmCallCount: number;
  selectedChunkTitles: string[];
  selectedChunkCount: number;
  answer: string;
  rationale?: string | null;
  terminatedReason?: string;
  stepsTaken?: number;
  error?: string;
}

const buildHistory = (priorTurn: { query: string; answer: string } | null): MessageRecord[] => {
  if (!priorTurn) return [];
  const now = new Date();
  return [
    {
      id: randomUUID(),
      conversationId: "compare-conv",
      workspaceId: "compare-ws",
      role: "user",
      content: priorTurn.query,
      createdAt: now,
    },
    {
      id: randomUUID(),
      conversationId: "compare-conv",
      workspaceId: "compare-ws",
      role: "assistant",
      content: priorTurn.answer,
      createdAt: now,
    },
  ];
};

const synthesizeAnswer = async (
  client: TextGenerationClient,
  pipelineResult: RetrievalPipelineResult,
  diagnosticLabel: string,
): Promise<string> => {
  if (pipelineResult.contexts.length === 0 && !pipelineResult.prompt) {
    process.stderr.write(`[debug] ${diagnosticLabel} pipeline returned 0 contexts and empty prompt\n`);
    return "(no contexts retrieved; pipeline returned an empty prompt)";
  }
  if (pipelineResult.contexts.length === 0) {
    process.stderr.write(`[debug] ${diagnosticLabel} pipeline returned 0 contexts with non-empty prompt (len=${pipelineResult.prompt.length})\n`);
  }
  const answer = await client.complete({
    systemPrompt: pipelineResult.systemPrompt,
    prompt: pipelineResult.prompt,
    maxOutputTokens: 600,
  });
  return answer.trim();
};

const runPipeline = async (input: {
  pipeline: RetrievalPipelineService;
  synthesizeClient: TextGenerationClient;
  counter: UsageCounter;
  workspaceId: string;
  query: string;
  history: MessageRecord[];
  queryCase: QueryCase;
  label: "deterministic" | "agentic";
}): Promise<RunOutcome> => {
  resetCounter(input.counter);
  const start = Date.now();
  try {
    const request: RetrievalPipelineRequest = {
      workspaceId: input.workspaceId,
      query: input.query,
      history: input.history,
    };
    const result = await input.pipeline.run(request);
    const answer = await synthesizeAnswer(input.synthesizeClient, result, `${input.label} ${input.queryCase.id}`);
    const wallTimeMs = Date.now() - start;
    return {
      pipeline: input.label,
      queryId: input.queryCase.id,
      query: input.query,
      wallTimeMs,
      tokenEstimate: estimateTokens(input.counter.inputChars + input.counter.outputChars),
      llmCallCount: input.counter.callCount,
      selectedChunkTitles: result.contexts.map((c) => c.title),
      selectedChunkCount: result.contexts.length,
      answer,
      rationale: result.trace.summary?.agentic?.finalRationale ?? null,
      terminatedReason: result.trace.summary?.agentic?.terminatedReason,
      stepsTaken: result.trace.summary?.agentic?.stepsTaken,
    };
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    process.stderr.write(`\n[debug] ${input.label} ${input.queryCase.id} threw: ${msg}\n`);
    return {
      pipeline: input.label,
      queryId: input.queryCase.id,
      query: input.query,
      wallTimeMs: Date.now() - start,
      tokenEstimate: estimateTokens(input.counter.inputChars + input.counter.outputChars),
      llmCallCount: input.counter.callCount,
      selectedChunkTitles: [],
      selectedChunkCount: 0,
      answer: "(error)",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const llmConfig = resolveLlmConfig(process.env);
  const database = new Database(databaseUrl, { applicationName: "agentic-retrieval-compare" });

  const settingsService: RetrievalSettingsService = {
    async getForWorkspace(workspaceId: string): Promise<RetrievalSettingsRecord> {
      return { ...defaultRetrievalSettings(workspaceId), queryRewriteEnabled: true, rerankEnabled: true };
    },
    async snapshotForWorkspace(workspaceId: string) {
      return freezeRetrievalSettings({
        ...defaultRetrievalSettings(workspaceId),
        queryRewriteEnabled: true,
        rerankEnabled: true,
      });
    },
  } as unknown as RetrievalSettingsService;
  const telemetryService = { emit: async () => {} } as unknown as TelemetryService;

  const buildDeterministic = (): { pipeline: RetrievalPipelineService; counter: UsageCounter; synthesize: TextGenerationClient } => {
    const { registry, counter } = buildCountingRegistry(llmConfig);
    const embeddingService = new EmbeddingService(registry.createEmbeddingGateway());
    const pipeline = new RetrievalPipelineService(
      settingsService,
      embeddingService,
      new PgVectorIndex(database),
      new PgLexicalSearch(database),
      new ConversationContextService(),
      new QueryRewriteService(registry.createRewriteGateway(), registry.createTriggerAnalysisGateway()),
      new CandidatePreparationService(),
      undefined,
      new RerankService(registry.createRerankGateway()),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(telemetryService),
      undefined,
      undefined,
      undefined,
      new PostgresChunkCandidateHydrator(database.kysely),
    );
    return { pipeline, counter, synthesize: registry.createChatTextClient() };
  };

  const buildAgentic = (): { pipeline: RetrievalPipelineService; counter: UsageCounter; synthesize: TextGenerationClient } => {
    const { registry, counter } = buildCountingRegistry(llmConfig);
    const embeddingService = new EmbeddingService(registry.createEmbeddingGateway());
    const vectorIndex = new PgVectorIndex(database);
    const chunkHydrator = new PostgresChunkCandidateHydrator(database.kysely);
    const lexicalSearch = new PgLexicalSearch(database);
    const deterministicInside = new RetrievalPipelineService(
      settingsService,
      embeddingService,
      vectorIndex,
      lexicalSearch,
      new ConversationContextService(),
      new QueryRewriteService(registry.createRewriteGateway(), registry.createTriggerAnalysisGateway()),
      new CandidatePreparationService(),
      undefined,
      new RerankService(registry.createRerankGateway()),
      new PromptContextSelectorService(),
      new PromptBuilder(),
      new RetrievalExecutionTelemetryService(telemetryService),
      undefined,
      undefined,
      undefined,
      chunkHydrator,
    );
    const runner = new AgenticRetrievalRunner({
      capabilityRunner: new AgenticCapabilityRunner({
        runtime: new DefaultAgentRuntime({ gateway: registry.createToolCallingGateway() }),
      }),
      embeddings: embeddingService,
      vectorIndex,
      chunkHydrator,
      lexicalSearch,
      queryRewrite: new GatewayQueryRewritePortAdapter(registry.createRewriteGateway()),
      rerankGateway: registry.createRerankGateway(),
    });
    const systemPrompt = loadPromptTemplate("agentic-retrieval/system.md");
    const pipeline = new AgenticRetrievalPipelineService({
      deterministic: deterministicInside,
      runner,
      promptBuilder: new PromptBuilder(),
      systemPrompt,
    }) as unknown as RetrievalPipelineService;
    return { pipeline, counter, synthesize: registry.createChatTextClient() };
  };

  const det = buildDeterministic();
  const ag = buildAgentic();

  const outcomes: RunOutcome[] = [];
  const turnState = new Map<
    string,
    { deterministic: { query: string; answer: string }; agentic: { query: string; answer: string } }
  >();

  for (const queryCase of QUERIES) {
    const prior = queryCase.followUpToId ? turnState.get(queryCase.followUpToId) : undefined;
    const detHistory = buildHistory(prior?.deterministic ?? null);
    const agHistory = buildHistory(prior?.agentic ?? null);
    process.stdout.write(`\n[${queryCase.id}] ${queryCase.query}${queryCase.followUpToId ? `  (follow-up to ${queryCase.followUpToId})` : ""}\n`);

    const detRunOutcomes: RunOutcome[] = [];
    for (let run = 1; run <= args.runs; run += 1) {
      process.stdout.write(`  deterministic run ${run}/${args.runs}...\n`);
      const outcome = await runPipeline({
        pipeline: det.pipeline,
        synthesizeClient: det.synthesize,
        counter: det.counter,
        workspaceId: args.workspaceId,
        query: queryCase.query,
        history: detHistory,
        queryCase,
        label: "deterministic",
      });
      detRunOutcomes.push(outcome);
      outcomes.push(outcome);
      process.stdout.write(
        `    ${outcome.wallTimeMs}ms · ${outcome.tokenEstimate}t · ${outcome.llmCallCount} calls · ${outcome.selectedChunkCount} chunks${outcome.error ? ` · ERROR: ${outcome.error}` : ""}\n`,
      );
    }

    const agRunOutcomes: RunOutcome[] = [];
    for (let run = 1; run <= args.runs; run += 1) {
      process.stdout.write(`  agentic run ${run}/${args.runs}...\n`);
      const outcome = await runPipeline({
        pipeline: ag.pipeline,
        synthesizeClient: ag.synthesize,
        counter: ag.counter,
        workspaceId: args.workspaceId,
        query: queryCase.query,
        history: agHistory,
        queryCase,
        label: "agentic",
      });
      agRunOutcomes.push(outcome);
      outcomes.push(outcome);
      process.stdout.write(
        `    ${outcome.wallTimeMs}ms · ${outcome.tokenEstimate}t · ${outcome.llmCallCount} calls · ${outcome.selectedChunkCount} chunks · ${outcome.stepsTaken ?? "?"} steps · ${outcome.terminatedReason ?? "?"}${outcome.error ? ` · ERROR: ${outcome.error}` : ""}\n`,
      );
    }

    // Thread the first successful run of each pipeline as conversation history for any follow-up query.
    const firstDet = detRunOutcomes.find((o) => !o.error) ?? detRunOutcomes[0];
    const firstAg = agRunOutcomes.find((o) => !o.error) ?? agRunOutcomes[0];
    turnState.set(queryCase.id, {
      deterministic: { query: queryCase.query, answer: firstDet.answer },
      agentic: { query: queryCase.query, answer: firstAg.answer },
    });
  }

  const report = renderReport(outcomes, args.runs);
  if (args.reportPath) {
    await writeFile(args.reportPath, report, "utf8");
    process.stdout.write(`\nReport written to ${args.reportPath}\n`);
  } else {
    process.stdout.write(`\n${report}\n`);
  }

  await database.pool.end();
};

interface AggregateStats {
  avg: number;
  min: number;
  max: number;
  count: number;
}

const aggregate = (values: number[]): AggregateStats => {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, count: 0 };
  return {
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    count: values.length,
  };
};

const fmt = (s: AggregateStats): string =>
  s.count === 0 ? "-" : s.count === 1 ? `${Math.round(s.avg)}` : `${Math.round(s.avg)} [${s.min}–${s.max}]`;

const renderReport = (outcomes: RunOutcome[], runs: number): string => {
  const lines: string[] = [`# Deterministic vs Agentic — Comparison Report (${runs} run${runs > 1 ? "s" : ""} per query)`, ""];
  const grouped = new Map<string, RunOutcome[]>();
  for (const outcome of outcomes) {
    const list = grouped.get(outcome.queryId) ?? [];
    list.push(outcome);
    grouped.set(outcome.queryId, list);
  }

  const aggregateFor = (list: RunOutcome[], pipeline: "deterministic" | "agentic") => {
    const runsOf = list.filter((o) => o.pipeline === pipeline);
    return {
      wall: aggregate(runsOf.map((o) => o.wallTimeMs)),
      tokens: aggregate(runsOf.map((o) => o.tokenEstimate)),
      calls: aggregate(runsOf.map((o) => o.llmCallCount)),
      chunks: aggregate(runsOf.map((o) => o.selectedChunkCount)),
      steps: aggregate(runsOf.map((o) => o.stepsTaken ?? 0).filter((n) => n > 0)),
      terminations: runsOf.map((o) => o.terminatedReason ?? "").filter((s) => s.length > 0),
      errors: runsOf.filter((o) => o.error).length,
    };
  };

  lines.push("## Summary (avg [min–max])");
  lines.push("");
  lines.push("| Query | Det wall (ms) | Ag wall (ms) | Det tokens | Ag tokens | Det calls | Ag calls | Ag steps | Ag terminations |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const queryCase of QUERIES) {
    const list = grouped.get(queryCase.id) ?? [];
    const detAgg = aggregateFor(list, "deterministic");
    const agAgg = aggregateFor(list, "agentic");
    const terminationSummary = Array.from(new Set(agAgg.terminations)).join(", ") || "-";
    lines.push(
      `| ${queryCase.id}: ${queryCase.query.slice(0, 50)}${queryCase.query.length > 50 ? "…" : ""} ` +
        `| ${fmt(detAgg.wall)} | ${fmt(agAgg.wall)} ` +
        `| ${fmt(detAgg.tokens)} | ${fmt(agAgg.tokens)} ` +
        `| ${fmt(detAgg.calls)} | ${fmt(agAgg.calls)} ` +
        `| ${fmt(agAgg.steps)} | ${terminationSummary} |`,
    );
  }
  lines.push("");

  // Totals row across all queries.
  const allDet = outcomes.filter((o) => o.pipeline === "deterministic");
  const allAg = outcomes.filter((o) => o.pipeline === "agentic");
  const sumPerRun = (xs: RunOutcome[], picker: (o: RunOutcome) => number): AggregateStats => {
    const perRun = new Map<number, number>();
    for (let r = 0; r < runs; r += 1) perRun.set(r, 0);
    let runCounter = 0;
    let lastQuery: string | null = null;
    for (const o of xs) {
      if (o.queryId !== lastQuery) {
        runCounter = 0;
        lastQuery = o.queryId;
      }
      perRun.set(runCounter, (perRun.get(runCounter) ?? 0) + picker(o));
      runCounter += 1;
    }
    return aggregate([...perRun.values()]);
  };
  lines.push("**Per-run totals across all 7 queries:**");
  lines.push("");
  lines.push("| Pipeline | Wall total (ms) | Tokens total | LLM calls total |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Deterministic | ${fmt(sumPerRun(allDet, (o) => o.wallTimeMs))} | ${fmt(sumPerRun(allDet, (o) => o.tokenEstimate))} | ${fmt(sumPerRun(allDet, (o) => o.llmCallCount))} |`,
  );
  lines.push(
    `| Agentic | ${fmt(sumPerRun(allAg, (o) => o.wallTimeMs))} | ${fmt(sumPerRun(allAg, (o) => o.tokenEstimate))} | ${fmt(sumPerRun(allAg, (o) => o.llmCallCount))} |`,
  );
  lines.push("");

  for (const queryCase of QUERIES) {
    lines.push(`## ${queryCase.id}. ${queryCase.query}`);
    if (queryCase.followUpToId) lines.push(`_Follow-up to query ${queryCase.followUpToId}_`);
    lines.push("");
    const list = grouped.get(queryCase.id) ?? [];
    for (const pipeline of ["deterministic", "agentic"] as const) {
      lines.push(`### ${pipeline}`);
      lines.push("");
      const runsOf = list.filter((o) => o.pipeline === pipeline);
      runsOf.forEach((outcome, i) => {
        lines.push(`**Run ${i + 1}:**`);
        lines.push(`- Wall ${outcome.wallTimeMs} ms · LLM calls ${outcome.llmCallCount} · ~${outcome.tokenEstimate} tokens · ${outcome.selectedChunkCount} chunks`);
        if (outcome.pipeline === "agentic") {
          lines.push(`- Steps: ${outcome.stepsTaken ?? "-"} · Terminated: ${outcome.terminatedReason ?? "-"}`);
          if (outcome.rationale) lines.push(`- Rationale: ${outcome.rationale.slice(0, 200)}`);
        }
        if (outcome.error) lines.push(`- **ERROR**: ${outcome.error}`);
        lines.push("");
        lines.push(outcome.answer || "(empty)");
        lines.push("");
      });
    }
  }
  return lines.join("\n");
};

main().catch((err) => {
  process.stderr.write(`compare failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
