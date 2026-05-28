/**
 * DEVELOPMENT TOOL. Not part of any production build, not invoked at runtime,
 * not compiled into `dist/` (tsconfig includes only `src/` and `tests/`).
 * Lives under `backend/scripts/dev/` to keep it visibly separate from
 * build-time codegen scripts in `backend/scripts/`.
 *
 * Smoke test for agentic retrieval against a real workspace.
 *
 * Wires the agent runtime + tool catalog + pipeline service against the dev
 * Postgres and whichever LLM provider is configured via env. Prints the
 * agent's tool-call trace, selected chunks, and rationale.
 *
 * Usage:
 *   cd backend && pnpm exec tsx scripts/dev/agenticRetrievalSmoke.ts \
 *     --workspace-id <uuid> \
 *     --query "who was Mahatma Gandhi"
 *
 * Env vars required:
 *   DATABASE_URL                    Postgres connection string
 *   LLM_CHAT_PROVIDER               openai | claude | gemini | openai-compatible
 *   LLM_CHAT_MODEL                  e.g. gpt-5.2, claude-sonnet-4-5
 *   <provider>_API_KEY              e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY
 *   LLM_EMBEDDING_PROVIDER          openai | openai-compatible | gemini
 *   LLM_EMBEDDING_MODEL             e.g. text-embedding-3-small
 *
 * Optional:
 *   AGENTIC_MAX_STEPS               default 6
 *   AGENTIC_MAX_TOOL_TOKENS         default 12000
 *   AGENTIC_MAX_WALL_MS             default 30000
 */

import { Database } from "../../src/shared/infra/database.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { resolveLlmConfig } from "../../src/shared/infra/llm/providerConfig.js";
import { LlmProviderRegistry } from "../../src/shared/infra/llm/providerRegistry.js";
import { DefaultAgentRuntime } from "../../src/shared/agent-runtime/index.js";
import { PgVectorSearch } from "../../src/modules/retrieval/infra/vectorSearch.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { EmbeddingService } from "../../src/modules/retrieval/services/embeddingService.js";
import { GatewayQueryRewritePortAdapter } from "../../src/modules/retrieval/services/gatewayQueryRewritePortAdapter.js";
import { AgenticRetrievalRunner } from "../../src/modules/retrieval/services/agenticRetrievalRunner.js";

interface CliArgs {
  workspaceId: string;
  query: string;
  maxSteps?: number;
  maxToolTokens?: number;
  maxWallMs?: number;
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
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace-id") {
      args.workspaceId = argv[++i];
    } else if (arg === "--query") {
      args.query = argv[++i];
    } else if (arg === "--max-steps") {
      args.maxSteps = parsePositiveInt(argv[++i], "--max-steps");
    } else if (arg === "--max-tool-tokens") {
      args.maxToolTokens = parsePositiveInt(argv[++i], "--max-tool-tokens");
    } else if (arg === "--max-wall-ms") {
      args.maxWallMs = parsePositiveInt(argv[++i], "--max-wall-ms");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.workspaceId || !args.query) {
    printHelp();
    process.exit(1);
  }
  return args as CliArgs;
};

const printHelp = (): void => {
  process.stdout.write(
    "Usage: pnpm exec tsx scripts/dev/agenticRetrievalSmoke.ts --workspace-id <uuid> --query <text> [--max-steps N] [--max-tool-tokens N] [--max-wall-ms N]\n",
  );
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const llmConfig = resolveLlmConfig(process.env);
  const database = new Database(databaseUrl, { applicationName: "agentic-retrieval-smoke" });
  const registry = new LlmProviderRegistry(llmConfig);
  const embeddingService = new EmbeddingService(registry.createEmbeddingGateway());
  const vectorSearch = new PgVectorSearch(database);
  const lexicalSearch = new PgLexicalSearch(database);
  const queryRewritePort = new GatewayQueryRewritePortAdapter(registry.createRewriteGateway());
  const rerankGateway = registry.createRerankGateway();
  const toolCallingGateway = registry.createToolCallingGateway();
  const runtime = new DefaultAgentRuntime({ gateway: toolCallingGateway });
  const systemPrompt = loadPromptTemplate("agentic-retrieval/system.md");

  const runner = new AgenticRetrievalRunner({
    runtime,
    embeddings: embeddingService,
    vectorSearch,
    lexicalSearch,
    queryRewrite: queryRewritePort,
    rerankGateway,
  });

  process.stdout.write(`Running agentic retrieval\n`);
  process.stdout.write(`  workspace: ${args.workspaceId}\n`);
  process.stdout.write(`  query: ${args.query}\n`);
  process.stdout.write(`  chat provider: ${llmConfig.chat.provider} (${llmConfig.chat.model})\n`);
  process.stdout.write(`  budgets: maxSteps=${args.maxSteps ?? 6}, maxToolTokens=${args.maxToolTokens ?? 12000}, maxWallMs=${args.maxWallMs ?? 30000}\n\n`);

  try {
    const result = await runner.run({
      workspaceId: args.workspaceId,
      query: args.query,
      systemPrompt,
      budgets: {
        maxSteps: args.maxSteps,
        maxToolResultTokens: args.maxToolTokens,
        maxWallTimeMs: args.maxWallMs,
      },
      embeddingModel: llmConfig.embeddings.model,
    });

    process.stdout.write(`=== Terminated: ${result.terminatedReason} (${result.stepsTaken} steps, ${result.trace.summary?.agentic?.wallTimeMs}ms) ===\n\n`);
    process.stdout.write(`=== Tool calls ===\n`);
    for (const stage of result.trace.stages) {
      if (stage.kind !== "agent_tool_call") continue;
      const toolName = (stage.inputs?.toolName as string | undefined) ?? "(unknown)";
      const tokens = (stage.metrics?.resultTokens as number | undefined) ?? 0;
      const latency = (stage.metrics?.latencyMs as number | undefined) ?? 0;
      const args = stage.inputs?.arguments;
      process.stdout.write(
        `  [${stage.status}] ${toolName}  args=${truncate(JSON.stringify(args ?? {}), 200)}  ${latency}ms  ${tokens}t\n`,
      );
      if (stage.reason) {
        process.stdout.write(`    reason: ${stage.reason}\n`);
      }
    }
    process.stdout.write(`\n=== Rationale ===\n${result.rationale ?? "(none — agent did not call finalize)"}\n\n`);
    process.stdout.write(`=== Selected chunks (${result.selectedChunks.length}) ===\n`);
    for (const chunk of result.selectedChunks) {
      process.stdout.write(`  ${chunk.chunkId}  ${chunk.title}\n`);
      process.stdout.write(`    ${truncate(chunk.snippet, 180)}\n`);
    }
  } finally {
    await database.pool.end();
  }
};

main().catch((err) => {
  process.stderr.write(`agentic retrieval smoke failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
