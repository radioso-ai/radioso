import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { LlmProviderMetadata, TextGenerationClient, TextGenerationResult, TextGenerationStreamResult } from "../../src/shared/infra/llm/providerTypes.js";
import { DurableUsageEventRecorder } from "../../src/shared/infra/usage/durableUsageEventRecorder.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A Test Chat side is not a stored conversation: its conversation and message ids name no row in
// `conversations` or `messages`. The ledger keeps the spend of those calls all the same.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

class ScriptedClient implements TextGenerationClient {
  readonly metadata: LlmProviderMetadata = { capability: "chat", provider: "openai", model: "gpt-test" };
  async complete(): Promise<TextGenerationResult> {
    return { text: "ok", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, quality: "actual" } };
  }
  stream(): TextGenerationStreamResult {
    throw new Error("not used");
  }
}

describeIntegration("Test Chat model calls on the usage ledger", () => {
  let database: Database;

  beforeAll(() => {
    database = new Database(integrationDatabaseUrl);
  });
  afterAll(async () => {
    await database.close();
  });

  it("records an event for each call a Test Chat turn makes, though its conversation and message are not stored", async () => {
    const account = await new AccountRepository(database.kysely).create({ name: "Test Chat Usage Org", email: `test-chat-usage-${randomUUID()}@example.com`, passwordHash: "hash" });
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Test Chat Usage Workspace");
    const pipeline = new ModelInferencePipelineService(new ScriptedClient(), new DurableUsageEventRecorder(database.kysely));
    const conversationId = randomUUID();
    const messageId = randomUUID();

    for (const [surface, operation] of [["test_execution", "answer"], ["context_classification", "classification"]] as const) {
      await pipeline.complete({
        prompt: "hello",
        operation: { accountId: account.id, workspaceId: workspace.id, conversationId, messageId, surface, operation, attemptKey: `${operation}:1` },
      });
    }

    const rows = await database.query<{ surface: string; operation: string; total_tokens: string }>(
      "SELECT surface, operation, total_tokens FROM usage_events WHERE workspace_id = $1 ORDER BY operation",
      [workspace.id],
    );
    expect(rows.map((row) => [row.surface, row.operation, row.total_tokens])).toEqual([
      ["test_execution", "answer", "12"],
      ["context_classification", "classification", "12"],
    ]);
  });
});
