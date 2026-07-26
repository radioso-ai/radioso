import { randomUUID } from "node:crypto";

import {
  afterAll,
} from "vitest";

import type {
  EmbeddingSpaceRef,
  VectorAdapter,
  VectorCandidateSearchInput,
  VectorIndexMutation,
} from "../../src/modules/retrieval/domain/vectorAdapter.js";
import { compareVectorIndexVersions } from "../../src/modules/retrieval/domain/vectorAdapter.js";
import { PgVectorAdapter } from "../../src/modules/retrieval/infra/pgVectorAdapter.js";
import { Database } from "../../src/shared/infra/database.js";
import { runVectorAdapterConformance } from "../contract/vector-adapter-conformance.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } =
  await resolveIntegrationDatabase();

const database = new Database(integrationDatabaseUrl);
const accounts = new Set<string>();

afterAll(async () => {
  for (const accountId of accounts) {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId])
      .catch(() => undefined);
  }
  await database.close().catch(() => undefined);
});

describeIntegration("PgVectorAdapter conformance integration", () => {
  runVectorAdapterConformance("pgvector", async () => {
    const fixture = new CanonicalPgVectorFixture(database);
    await fixture.initialize();
    return {
      adapter: fixture.adapter,
      dispose: () => fixture.dispose(),
    };
  });
});

class CanonicalPgVectorFixture {
  private readonly pg: PgVectorAdapter;
  private readonly logicalToPhysical = new Map<string, string>();
  private readonly physicalToLogical = new Map<string, string>();
  private readonly versions = new Map<string, string>();
  private readonly accountId = randomUUID();
  private readonly idPrefix = randomUUID().slice(0, 24);
  private idCounter = 0;

  readonly adapter: VectorAdapter;

  constructor(private readonly database: Database) {
    this.pg = new PgVectorAdapter(database);
    this.adapter = {
      capabilities: this.pg.capabilities,
      admin: {
        prepareSpace: async ({ space }) => {
          const mapped = await this.ensureSpace(space);
          await this.pg.admin.prepareSpace({ space: mapped });
        },
        resetSpace: async ({ spaceId, workspaceId }) => {
          const physicalSpaceId = this.id(`space:${spaceId}`);
          const physicalWorkspaceId = workspaceId
            ? this.id(`workspace:${workspaceId}`)
            : null;
          await this.database.query(
            `DELETE FROM chunk_embeddings
             WHERE embedding_space_id = $1
               AND ($2::uuid IS NULL OR workspace_id = $2)`,
            [physicalSpaceId, physicalWorkspaceId],
          );
          await this.pg.admin.resetSpace({
            spaceId: physicalSpaceId,
            workspaceId: physicalWorkspaceId ?? undefined,
          });
        },
        getHealth: ({ spaceId }) => this.pg.admin.getHealth({
          spaceId: spaceId ? this.id(`space:${spaceId}`) : undefined,
        }),
      },
      writer: {
        applyMutations: async (input) => {
          const workspaceId = await this.ensureWorkspace(input.workspaceId);
          const space = await this.ensureSpace(input.space);
          const mappedMutations: VectorIndexMutation[] = [];
          for (const mutation of input.mutations) {
            await this.materializeCanonicalMutation(
              input.workspaceId,
              input.space,
              mutation,
            );
            mappedMutations.push(this.mapMutation(input.workspaceId, mutation));
          }
          const result = await this.pg.writer.applyMutations({
            workspaceId,
            space,
            mutations: mappedMutations,
          });
          return {
            mutations: result.mutations.map((item) => ({
              ...item,
              chunkId: this.logical(item.chunkId),
            })),
          };
        },
      },
      search: {
        search: async (input) => {
          const mapped = await this.mapSearch(input);
          const results = await this.pg.search.search(mapped);
          return results
            .map((candidate) => ({
              ...candidate,
              chunkId: this.logical(candidate.chunkId),
              documentId: this.logical(candidate.documentId),
              embeddingSpaceId: this.logical(candidate.embeddingSpaceId),
            }))
            .sort((left, right) =>
              right.score - left.score
              || left.chunkId.localeCompare(right.chunkId),
            );
        },
      },
    };
  }

  async initialize(): Promise<void> {
    accounts.add(this.accountId);
    await this.database.query(
      `INSERT INTO accounts (id, name, email, password_hash)
       VALUES ($1, 'Pg conformance', $2, 'hash')`,
      [this.accountId, `pg-conformance-${this.accountId}@example.com`],
    );
  }

  async dispose(): Promise<void> {
    await this.database.query(
      "DELETE FROM workspaces WHERE account_id = $1",
      [this.accountId],
    );
    const spaces = [...this.logicalToPhysical.entries()]
      .filter(([key]) => key.startsWith("space:"))
      .map(([, value]) => value);
    if (spaces.length > 0) {
      await this.database.query(
        "DELETE FROM embedding_spaces WHERE id = ANY($1::uuid[])",
        [spaces],
      );
    }
    await this.database.query("DELETE FROM accounts WHERE id = $1", [this.accountId]);
    accounts.delete(this.accountId);
  }

  private id(logical: string): string {
    const existing = this.logicalToPhysical.get(logical);
    if (existing) {
      return existing;
    }
    const physical = `${this.idPrefix}${(++this.idCounter).toString(16).padStart(12, "0")}`;
    this.logicalToPhysical.set(logical, physical);
    this.physicalToLogical.set(physical, logical.split(":").at(-1)!);
    return physical;
  }

  private logical(physical: string): string {
    return this.physicalToLogical.get(physical) ?? physical;
  }

  private async ensureWorkspace(logical: string): Promise<string> {
    const workspaceId = this.id(`workspace:${logical}`);
    await this.database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, this.accountId, logical, `pg-conformance-${workspaceId}`],
    );
    return workspaceId;
  }

  private async ensureSpace(space: EmbeddingSpaceRef): Promise<EmbeddingSpaceRef> {
    const id = this.id(`space:${space.id}`);
    await this.database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint,
         model, dimensions, distance_metric, normalization
       )
       VALUES ($1, $2, 'openai', $3, $4, $5, 'cosine', 'provider_unit')
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        `pg-conformance-${id}`,
        `pg-conformance-endpoint-${id}`,
        `pg-conformance-model-${id}`,
        space.dimensions,
      ],
    );
    return { ...space, id };
  }

  private async ensureSource(
    workspaceId: string,
    logicalSourceId: string | null,
  ): Promise<string | null> {
    if (logicalSourceId === null) {
      return null;
    }
    const sourceId = this.id(`source:${workspaceId}:${logicalSourceId}`);
    await this.database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name)
       VALUES ($1, $2, 'api', $3)
       ON CONFLICT (id) DO NOTHING`,
      [sourceId, workspaceId, logicalSourceId],
    );
    return sourceId;
  }

  private async materializeCanonicalMutation(
    logicalWorkspaceId: string,
    logicalSpace: EmbeddingSpaceRef,
    mutation: VectorIndexMutation,
  ): Promise<void> {
    const workspaceId = await this.ensureWorkspace(logicalWorkspaceId);
    const space = await this.ensureSpace(logicalSpace);
    const logicalChunkId = mutation.kind === "upsert"
      ? mutation.record.chunkId
      : mutation.chunkId;
    const version = mutation.kind === "upsert"
      ? mutation.record.version
      : mutation.version;
    const versionKey = `${logicalWorkspaceId}\u0000${logicalSpace.id}\u0000${logicalChunkId}`;
    const current = this.versions.get(versionKey);
    if (current && compareVectorIndexVersions(version, current) <= 0) {
      return;
    }
    this.versions.set(versionKey, version);
    const chunkId = this.id(`chunk:${logicalWorkspaceId}:${logicalChunkId}`);
    if (mutation.kind === "delete") {
      await this.database.query(
        `DELETE FROM chunk_embeddings
         WHERE workspace_id = $1
           AND embedding_space_id = $2
           AND chunk_id = $3`,
        [workspaceId, space.id, chunkId],
      );
      return;
    }
    const documentId = this.id(
      `document:${logicalWorkspaceId}:${mutation.record.documentId}`,
    );
    const sourceId = await this.ensureSource(
      workspaceId,
      mutation.record.payload.sourceId,
    );
    await this.database.query(
      `INSERT INTO documents (
         id, workspace_id, title, source_content, markdown_content, status,
         revision, metadata, source_id, retrieval_enabled, retrieval_expires_at
       )
       VALUES ($1, $2, $3, 'source', 'markdown', 'ready', 1, '{}'::jsonb, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
       SET status = 'ready',
           source_id = EXCLUDED.source_id,
           retrieval_enabled = EXCLUDED.retrieval_enabled,
           retrieval_expires_at = EXCLUDED.retrieval_expires_at`,
      [
        documentId,
        workspaceId,
        mutation.record.documentId,
        sourceId,
        mutation.record.payload.retrievalEnabled,
        mutation.record.payload.retrievalExpiresAt,
      ],
    );
    await this.database.query(
      `INSERT INTO chunks (
         id, document_id, workspace_id, chunk_index, content, search_text, metadata
       )
       VALUES ($1, $2, $3, 0, 'content', 'search', $4::jsonb)
       ON CONFLICT (workspace_id, id) DO UPDATE
       SET metadata = EXCLUDED.metadata`,
      [
        chunkId,
        documentId,
        workspaceId,
        JSON.stringify(mutation.record.payload.metadata),
      ],
    );
    await this.database.query(
      `INSERT INTO chunk_embeddings (
         workspace_id, chunk_id, embedding_space_id, document_revision,
         canonical_version, dimensions, embedding, content_hash
       )
       VALUES ($1, $2, $3, 1, $4, $5, $6::vector, $7)
       ON CONFLICT (workspace_id, chunk_id, embedding_space_id) DO UPDATE
       SET canonical_version = EXCLUDED.canonical_version,
           dimensions = EXCLUDED.dimensions,
           embedding = EXCLUDED.embedding,
           content_hash = EXCLUDED.content_hash,
           updated_at = NOW()`,
      [
        workspaceId,
        chunkId,
        space.id,
        version,
        space.dimensions,
        `[${mutation.record.vector.join(",")}]`,
        `pg-conformance-${version}`,
      ],
    );
  }

  private mapMutation(
    logicalWorkspaceId: string,
    mutation: VectorIndexMutation,
  ): VectorIndexMutation {
    if (mutation.kind === "delete") {
      return {
        ...mutation,
        chunkId: this.id(`chunk:${logicalWorkspaceId}:${mutation.chunkId}`),
      };
    }
    return {
      kind: "upsert",
      record: {
        ...mutation.record,
        chunkId: this.id(`chunk:${logicalWorkspaceId}:${mutation.record.chunkId}`),
        documentId: this.id(
          `document:${logicalWorkspaceId}:${mutation.record.documentId}`,
        ),
      },
    };
  }

  private async mapSearch(
    input: VectorCandidateSearchInput,
  ): Promise<VectorCandidateSearchInput> {
    const workspaceId = await this.ensureWorkspace(input.workspaceId);
    const space = await this.ensureSpace(input.space);
    const source = input.filter.source?.constrained
      ? {
          ...input.filter.source,
          sourceIds: input.filter.source.sourceIds.map((sourceId) =>
            this.id(`source:${workspaceId}:${sourceId}`)),
        }
      : input.filter.source;
    return {
      ...input,
      workspaceId,
      space,
      filter: { ...input.filter, source },
    };
  }
}
