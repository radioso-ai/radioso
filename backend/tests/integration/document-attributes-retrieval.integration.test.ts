import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { IngestionSettingsRepository } from "../../src/db/repositories/ingestionSettingsRepository.js";
import { ChunkRepository } from "../../src/modules/documents/infra/chunkRepository.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentProcessingService } from "../../src/modules/documents/services/documentProcessingService.js";
import { DocumentProcessingWorker } from "../../src/modules/documents/services/documentProcessingWorker.js";
import { ChunkingStrategyRegistry } from "../../src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.js";
import { FixedWindowChunkingStrategy } from "../../src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.js";
import { readDocumentAttributes } from "../../src/modules/retrieval/domain/documentAttributes.js";
import type { FinalPromptContext } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievedChunk } from "../../src/modules/retrieval/domain/vectorSearch.js";
import { PgLexicalSearch } from "../../src/modules/retrieval/infra/lexicalSearch.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { propertyCorpus } from "../fixtures/document-attributes/propertyCorpus.js";
import { createAuditService } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const EMBEDDING_DIMENSIONS = 1536;

const toPromptContext = (chunk: RetrievedChunk): FinalPromptContext => ({
  ...chunk,
  retrievalSources: ["lexical"],
  retrievalText: chunk.searchText ?? chunk.content,
  semanticScore: 0,
  lexicalScore: chunk.similarity,
  relevanceScore: chunk.similarity,
  rerankPosition: 0,
  promptPosition: 0,
  estimatedTokenCost: 1,
});

describeIntegration("document attributes through the worker and retrieval (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const embeddingSpaceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Location Catalogue Co", `catalogue-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Location Catalogue", `catalogue-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model,
         dimensions, distance_metric, normalization, document_task, query_task,
         vector_options
       )
       VALUES ($1, $2, 'openai', 'document-attributes-test-scope',
               'text-embedding-3-small', $3, 'cosine', 'provider_unit',
               NULL, NULL, '{}'::jsonb)`,
      [embeddingSpaceId, `document-attributes-${embeddingSpaceId}`, EMBEDDING_DIMENSIONS],
    );

    const auditService = createAuditService();
    const documentRepository = new DocumentRepository(database.kysely);
    const jobRepository = new DocumentProcessingJobRepository(database.kysely);
    const processingService = new DocumentProcessingService(
      documentRepository,
      new ChunkRepository(database),
      {
        async embedDocumentChunks(request) {
          return {
            space: { id: embeddingSpaceId, dimensions: EMBEDDING_DIMENSIONS, distanceMetric: "cosine" },
            vectors: request.texts.map(() => {
              const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
              vector[0] = 1;
              return vector;
            }),
          };
        },
      },
      auditService,
      new IngestionSettingsService(new IngestionSettingsRepository(database.kysely), auditService),
      new ChunkingStrategyRegistry([new FixedWindowChunkingStrategy()]),
    );
    const worker = new DocumentProcessingWorker(
      documentRepository,
      jobRepository,
      processingService,
      auditService,
      createLogger("silent"),
    );
    const ingestion = new DocumentIngestionService(documentRepository, auditService);

    for (const property of propertyCorpus) {
      await ingestion.ingest({ workspaceId, title: property.title, content: property.markdown });
    }
    for (const _property of propertyCorpus) {
      await worker.runOnce();
    }
  });

  afterAll(async () => {
    await database.query("DELETE FROM chunks WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM vector_index_work WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM vector_index_checkpoints WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM document_processing_jobs WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [embeddingSpaceId]).catch(() => undefined);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close();
  });

  it("stores every chunk of every document with that document's region", async () => {
    const rows = await database.query<{ title: string; chunk_index: number; metadata: Record<string, unknown>; search_text: string }>(
      `SELECT d.title, c.chunk_index, c.metadata, c.search_text
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.workspace_id = $1`,
      [workspaceId],
    );

    for (const property of propertyCorpus) {
      const chunks = rows.filter((row) => row.title === property.title);
      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(readDocumentAttributes(chunk.metadata)).toContainEqual({ label: "Region", value: property.region });
        expect(chunk.search_text).toContain(`Region: ${property.region}`);
      }
    }
  });

  it("retrieves a chunk from deep in a document with its region in the answer prompt", async () => {
    const search = new PgLexicalSearch(database);

    for (const property of propertyCorpus) {
      const { matches } = await search.search({ workspaceId, query: property.deepPhrase, topK: 5, matchMode: "all_terms" });
      const deepChunk = matches.find((match) => match.title === property.title && (match.chunkIndex ?? 0) > 0);

      expect(deepChunk, property.title).toBeDefined();
      expect(deepChunk!.content).toContain(property.deepPhrase);
      expect(deepChunk!.content).not.toContain(property.region);

      const { prompt } = new PromptBuilder().build({
        query: `Where is the ${property.deepPhrase}?`,
        history: [],
        contexts: [toPromptContext(deepChunk!)],
        timeZone: "UTC",
        settings: {},
      });
      expect(prompt).toContain(`Result 1 (${property.title}): Attributes: Property id:`);
      expect(prompt).toContain(`Region: ${property.region}`);
    }
  });

  it("finds every chunk of a document by its region", async () => {
    const search = new PgLexicalSearch(database);
    const umbria = propertyCorpus.find((property) => property.region === "Umbria")!;
    const { matches } = await search.search({ workspaceId, query: "Umbria", topK: 20, matchMode: "all_terms" });
    const [{ count }] = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.workspace_id = $1 AND d.title = $2`,
      [workspaceId, umbria.title],
    );

    expect(matches.length).toBe(Number(count));
    expect(matches.every((match) => match.title === umbria.title)).toBe(true);
  });
});
