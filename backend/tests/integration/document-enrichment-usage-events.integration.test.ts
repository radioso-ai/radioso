import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { ModelDocumentEnrichmentGateway } from "../../src/modules/documents/infra/modelDocumentEnrichmentGateway.js";
import { Database } from "../../src/shared/infra/database.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type {
  LlmProviderMetadata,
  TextGenerationClient,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "../../src/shared/infra/llm/providerTypes.js";
import { DurableUsageEventRecorder } from "../../src/shared/infra/usage/durableUsageEventRecorder.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The spend a monthly per-account report sums for metadata extraction: one ledger row per
// model call, attributed to the account and linked to the document and revision it read.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const REPLY = JSON.stringify({ type: "reference", confidence: 0.9, facts: [] });

class ScriptedEnrichmentClient implements TextGenerationClient {
  readonly metadata: LlmProviderMetadata = { capability: "chat", provider: "openai", model: "gpt-enrichment-test" };

  constructor(private readonly beforeReply: () => Promise<void> = async () => {}) {}

  async complete(): Promise<TextGenerationResult> {
    await this.beforeReply();
    return {
      text: REPLY,
      stopReason: "completed",
      usage: { inputTokens: 512, outputTokens: 88, cachedInputTokens: 384, reasoningTokens: 20, totalTokens: 600, quality: "actual" },
    };
  }

  stream(): TextGenerationStreamResult {
    throw new Error("enrichment never streams");
  }
}

interface UsageRow {
  account_id: string | null;
  document_id: string | null;
  document_revision: number | null;
  surface: string;
  operation: string;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string | null;
  reasoning_tokens: string | null;
  input_bytes: string;
}

describeIntegration("document enrichment usage events", () => {
  let database: Database;
  let documents: DocumentRepository;
  const accountId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl);
    documents = new DocumentRepository(database.kysely);
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Enrichment Spend Co", `enrichment-spend-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Enrichment Spend Workspace", `enrichment-spend-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM usage_events WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createDocument = () =>
    documents.createAndQueue({
      workspaceId,
      title: "Opening hours",
      sourceContent: "Open daily from nine to five.",
      markdownContent: "Open daily from nine to five.",
    });

  const enrich = (gateway: ModelDocumentEnrichmentGateway, document: { id: string; revision: number }) =>
    gateway.generate({
      workspaceId,
      documentId: document.id,
      documentRevision: document.revision,
      prompt: "Classify the document.",
      documentRepresentation: "Title: Opening hours\n\nOpen daily from nine to five.",
      outputSchema: { type: "object" },
    });

  const usageRowsFor = (documentId: string | null) =>
    database.query<UsageRow>(
      `SELECT account_id, document_id, document_revision, surface, operation, input_tokens, output_tokens,
              cached_input_tokens, reasoning_tokens, input_bytes
         FROM usage_events
        WHERE workspace_id = $1 AND operation = 'document_enrichment'
          AND document_id IS NOT DISTINCT FROM $2
        ORDER BY occurred_at, id`,
      [workspaceId, documentId],
    );

  it("records each call against the account, the document and the revision it read, with its tokens", async () => {
    const document = await createDocument();
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const gateway = new ModelDocumentEnrichmentGateway(new ModelInferencePipelineService(new ScriptedEnrichmentClient(), recorder));

    await enrich(gateway, document);

    const rows = await usageRowsFor(document.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: accountId,
      document_id: document.id,
      document_revision: document.revision,
      surface: "documents",
      operation: "document_enrichment",
    });
    expect(Number(rows[0].input_tokens)).toBe(512);
    expect(Number(rows[0].output_tokens)).toBe(88);
    expect(Number(rows[0].cached_input_tokens)).toBe(384);
    expect(Number(rows[0].reasoning_tokens)).toBe(20);
  });

  it("keeps the spend of a call whose document is deleted while it runs", async () => {
    const document = await createDocument();
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const deletesDocument = new ScriptedEnrichmentClient(async () => {
      await database.query("DELETE FROM documents WHERE id = $1", [document.id]);
    });
    const gateway = new ModelDocumentEnrichmentGateway(new ModelInferencePipelineService(deletesDocument, recorder));
    const before = (await usageRowsFor(null)).length;

    await enrich(gateway, document);

    const unlinked = await usageRowsFor(null);
    expect(unlinked).toHaveLength(before + 1);
    expect(unlinked.at(-1)).toMatchObject({ account_id: accountId, document_revision: null });
    expect(Number(unlinked.at(-1)!.output_tokens)).toBe(88);
  });
});
