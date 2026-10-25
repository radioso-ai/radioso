import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { CopilotRepository } from "../../src/db/repositories/copilotRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { DurableUsageEventRecorder } from "../../src/shared/infra/usage/durableUsageEventRecorder.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type {
  LlmProviderMetadata,
  ProviderUsage,
  TextGenerationClient,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "../../src/shared/infra/llm/providerTypes.js";
import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  TextRoutedToolCallingGateway,
} from "../../src/shared/agent-runtime/index.js";
import { OperatorCopilotService } from "../../src/modules/operatorCopilot/public.js";
import { NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

// Proves the real route Ray's model calls take: AgenticCapabilityRunner -> DefaultAgentRuntime ->
// TextRoutedToolCallingGateway -> ModelInferencePipelineService -> the real DurableUsageEventRecorder
// against Postgres. Uses the real CopilotRepository too, not the in-memory fake: the usage ledger's
// copilot_conversation_id/copilot_message_id are foreign-keyed to copilot_conversations/
// copilot_messages, so a Ray conversation that never lands in Postgres would make every one of
// these calls fail that foreign key. Gated on INTEGRATION_DATABASE_URL; skips when no database is
// reachable.
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

/** Scripted stand-in for the provider: answers in order, usage included, for assertions on what
 * each call's recorded usage looked like. */
class ScriptedTextGenerationClient implements TextGenerationClient {
  readonly metadata: LlmProviderMetadata = { capability: "chat", provider: "openai", model: "gpt-ray-test" };
  readonly calls: TextGenerationRequest[] = [];

  constructor(private readonly script: ReadonlyArray<{ text: string; usage: ProviderUsage }>) {}

  async complete(request: TextGenerationRequest): Promise<TextGenerationResult> {
    this.calls.push(request);
    const next = this.script[this.calls.length - 1];
    if (!next) throw new Error(`ScriptedTextGenerationClient: script exhausted at call ${this.calls.length}`);
    return { text: next.text, usage: next.usage };
  }

  stream(): TextGenerationStreamResult {
    throw new Error("ScriptedTextGenerationClient: stream() is not used by the tool-calling gateway");
  }
}

const readerTool = (name: string, invoke: (input: unknown) => Promise<unknown>) => ({
  name,
  shape: "read" as const,
  verificationCost: () => 0,
  uiLabel: "Reader",
  description: "reader",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["workspace.agents.read"] as const,
  contributingModule: "test",
  dashboardSubject: { type: "workspace" as const },
  createTool: () => ({ name, description: "reader", inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }), invoke }),
});

const workspaceRouteKeyResolver = { resolveWorkspaceKey: async () => "workspace" };
const currentAuthorization = { hasAllPermissions: async () => true };

describeIfDatabase("copilot (Ray) usage events against the real ledger", () => {
  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let copilotRepository: CopilotRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    copilotRepository = new CopilotRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const seedWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Ray Usage Org",
      email: `ray-usage-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Ray Usage Workspace");
    const operatorUserId = randomUUID();
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      operatorUserId,
      `ray-usage-operator-${operatorUserId}@example.com`,
      "hash",
    ]);
    return { accountId: account.id, workspaceId: workspace.id, operatorUserId };
  };

  const operatorMessageFor = async (conversationId: string): Promise<{ id: string } | undefined> => {
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM copilot_messages WHERE conversation_id = $1 AND role = 'operator' ORDER BY created_at ASC`,
      [conversationId],
    );
    return rows.at(-1);
  };

  /** One real Ray-shaped call chain against the real CopilotRepository, reused by both tests
   * below so a second turn can run on the same (now Postgres-backed) conversation. */
  const buildRayService = (script: ReadonlyArray<{ text: string; usage: ProviderUsage }>, toolInvoke: () => Promise<unknown>) => {
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const client = new ScriptedTextGenerationClient(script);
    const pipeline = new ModelInferencePipelineService(client, recorder);
    const gateway = new TextRoutedToolCallingGateway(pipeline);
    const runtime = new DefaultAgentRuntime({ gateway });
    const capabilityRunner = new AgenticCapabilityRunner({ runtime });
    return new OperatorCopilotService({
      repository: copilotRepository,
      capabilityRunner,
      usageLimitPolicy: new NoopUsageLimitPolicy(),
      auditService: { record: async () => {} },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [readerTool("workspace_triage", toolInvoke)],
    });
  };

  const runTurn = async (
    service: OperatorCopilotService,
    input: { workspaceId: string; accountId: string; operatorUserId: string; conversationId: string | null; message: string },
  ): Promise<string> => {
    let conversationId: string | undefined;
    for await (const event of service.runTurn({
      surface: "dashboard",
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      operatorUserId: input.operatorUserId,
      conversationId: input.conversationId,
      message: input.message,
      pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.read"]),
    })) {
      if (event.event === "conversation") conversationId = (event.data as { conversationId: string }).conversationId;
    }
    if (!conversationId) throw new Error("turn never yielded a conversation id");
    return conversationId;
  };

  it("records one usage_events row per Ray model call with the Ray conversation/message link and correct tokens, no content", async () => {
    const { accountId, workspaceId, operatorUserId } = await seedWorkspace();
    const toolInvoke = async () => ({ value: "two handoffs are waiting" });
    const service = buildRayService(
      [
        {
          text: JSON.stringify({ text: "", tool_calls: [{ id: "call-1", name: "workspace_triage", arguments: {} }] }),
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 40, quality: "actual" },
        },
        {
          text: JSON.stringify({ text: "Two handoffs are waiting.", tool_calls: [] }),
          usage: { inputTokens: 260, outputTokens: 12, totalTokens: 272, cachedInputTokens: 200, quality: "actual" },
        },
      ],
      toolInvoke,
    );

    const conversationId = await runTurn(service, { workspaceId, accountId, operatorUserId, conversationId: null, message: "What needs attention?" });
    const operatorMessage = await operatorMessageFor(conversationId);
    expect(operatorMessage).toBeDefined();

    const rows = await database.query<{
      conversation_id: string | null;
      message_id: string | null;
      copilot_conversation_id: string | null;
      copilot_message_id: string | null;
      account_id: string | null;
      surface: string;
      operation: string;
      status: string;
      input_tokens: string;
      output_tokens: string;
      cached_input_tokens: string | null;
      total_tokens: string;
    }>(
      `SELECT conversation_id, message_id, copilot_conversation_id, copilot_message_id, account_id,
              surface, operation, status, input_tokens, output_tokens, cached_input_tokens, total_tokens
       FROM usage_events
       WHERE workspace_id = $1 AND surface = 'operator_copilot'
       ORDER BY input_tokens ASC`,
      [workspaceId],
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        // The assistant-shaped columns never hold a Ray id -- that is a separate, dedicated pair.
        conversation_id: null,
        message_id: null,
        copilot_conversation_id: conversationId,
        copilot_message_id: operatorMessage!.id,
        account_id: accountId,
        surface: "operator_copilot",
        operation: "agent_step",
        status: "succeeded",
      });
    }
    expect(Number(rows[0].input_tokens)).toBe(120);
    expect(Number(rows[0].output_tokens)).toBe(30);
    expect(Number(rows[0].cached_input_tokens)).toBe(40);
    expect(Number(rows[0].total_tokens)).toBe(150);
    expect(Number(rows[1].input_tokens)).toBe(260);
    expect(Number(rows[1].output_tokens)).toBe(12);
    expect(Number(rows[1].cached_input_tokens)).toBe(200);
    expect(Number(rows[1].total_tokens)).toBe(272);

    // The ledger's columns carry token counts, provider/model names, and lineage ids only.
    // Nothing in this schema can hold a prompt or a completion, so the full projection above is
    // already the whole row short of ids/timestamps/provider/model -- there is no content column
    // to assert absent.
  });

  it("links two turns on the same Ray conversation to the same copilot_conversation_id and a distinct copilot_message_id each", async () => {
    const { accountId, workspaceId, operatorUserId } = await seedWorkspace();
    const service = buildRayService(
      [
        { text: JSON.stringify({ text: "First answer.", tool_calls: [] }), usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, quality: "actual" } },
        { text: JSON.stringify({ text: "Second answer.", tool_calls: [] }), usage: { inputTokens: 60, outputTokens: 6, totalTokens: 66, quality: "actual" } },
      ],
      async () => ({ value: "unused" }),
    );

    const conversationId = await runTurn(service, { workspaceId, accountId, operatorUserId, conversationId: null, message: "First question?" });
    await runTurn(service, { workspaceId, accountId, operatorUserId, conversationId, message: "Second question?" });

    const operatorMessages = await database.query<{ id: string }>(
      `SELECT id FROM copilot_messages WHERE conversation_id = $1 AND role = 'operator' ORDER BY created_at ASC`,
      [conversationId],
    );
    expect(operatorMessages).toHaveLength(2);

    const rows = await database.query<{ copilot_conversation_id: string | null; copilot_message_id: string | null }>(
      `SELECT copilot_conversation_id, copilot_message_id FROM usage_events
       WHERE workspace_id = $1 AND surface = 'operator_copilot' ORDER BY occurred_at ASC`,
      [workspaceId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].copilot_conversation_id).toBe(conversationId);
    expect(rows[1].copilot_conversation_id).toBe(conversationId);
    expect(rows[0].copilot_message_id).toBe(operatorMessages[0].id);
    expect(rows[1].copilot_message_id).toBe(operatorMessages[1].id);
    expect(rows[0].copilot_message_id).not.toBe(rows[1].copilot_message_id);
  });

  it("records cached_input_tokens for an assistant-surface model call the same way", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const client = new ScriptedTextGenerationClient([
      {
        text: "Here's the answer.",
        usage: { inputTokens: 500, outputTokens: 40, totalTokens: 540, cachedInputTokens: 384, quality: "actual" },
      },
    ]);
    const pipeline = new ModelInferencePipelineService(client, recorder);

    await pipeline.complete({
      operation: {
        workspaceId,
        accountId,
        surface: "assistant",
        operation: "answer",
        attemptKey: `attempt:${randomUUID()}`,
      },
      prompt: "What are your hours?",
      systemPrompt: "You are a helpful assistant.",
    });

    const rows = await database.query<{ cached_input_tokens: string | null; input_tokens: string; surface: string }>(
      `SELECT cached_input_tokens, input_tokens, surface FROM usage_events WHERE workspace_id = $1 AND surface = 'assistant'`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("assistant");
    expect(Number(rows[0].input_tokens)).toBe(500);
    expect(Number(rows[0].cached_input_tokens)).toBe(384);
  });
});
