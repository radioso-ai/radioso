import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { PgTemporalCandidateRepository } from "../../src/modules/retrieval/infra/temporalCandidateRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PgTemporalCandidateRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new PgTemporalCandidateRepository(database);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const sourceId = randomUUID();
  const otherSourceId = randomUUID();

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Temporal Candidates Co", `temporal-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)`,
      [workspaceId, accountId, "Temporal Workspace", `temporal-${workspaceId}`, otherWorkspaceId, "Other Temporal Workspace", `temporal-${otherWorkspaceId}`],
    );
    await database.query(
      `INSERT INTO document_sources (id, workspace_id, kind, name, external_id, config, metadata)
       VALUES ($1, $2, 'website', 'Events', 'events', '{}'::jsonb, '{}'::jsonb),
              ($3, $2, 'website', 'Other Events', 'other-events', '{}'::jsonb, '{}'::jsonb)`,
      [sourceId, workspaceId, otherSourceId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const insertReadyDocumentWithChunk = async (input: {
    id?: string;
    workspaceId?: string;
    sourceId?: string | null;
    title: string;
    chunkId?: string;
    metadata: Record<string, unknown>;
    retrievalEnabled?: boolean;
    retrievalExpiresAt?: string | null;
  }): Promise<string> => {
    const documentId = input.id ?? randomUUID();
    const chunkId = input.chunkId ?? randomUUID();
    const workspace = input.workspaceId ?? workspaceId;
    await database.query(
      `INSERT INTO documents (id, workspace_id, title, source_content, markdown_content, status, source_id, metadata, retrieval_enabled, retrieval_expires_at)
       VALUES ($1, $2, $3, $4, $4, 'ready', $5, '{}'::jsonb, $6, $7)`,
      [documentId, workspace, input.title, `${input.title} body`, input.sourceId ?? sourceId, input.retrievalEnabled ?? true, input.retrievalExpiresAt ?? null],
    );
    await database.query(
      `INSERT INTO chunks (id, document_id, workspace_id, chunk_index, content, search_text, metadata)
       VALUES ($1, $2, $3, 0, $4, $4, $5::jsonb)`,
      [chunkId, documentId, workspace, `${input.title} chunk`, JSON.stringify(input.metadata)],
    );
    return chunkId;
  };

  it("returns ongoing and upcoming dated chunks soonest-first within workspace and source scope", async () => {
    const past = await insertReadyDocumentWithChunk({
      title: "Past Event",
      metadata: { dateFrom: "2026-06-01", dateTo: "2026-06-02" },
    });
    const ongoing = await insertReadyDocumentWithChunk({
      title: "Ongoing Event",
      metadata: { dateFrom: "2026-06-30", dateTo: "2026-07-03" },
    });
    const soon = await insertReadyDocumentWithChunk({
      title: "Soon Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
    });
    const later = await insertReadyDocumentWithChunk({
      title: "Later Event",
      metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
    });
    const otherSource = await insertReadyDocumentWithChunk({
      title: "Other Source Event",
      sourceId: otherSourceId,
      metadata: { dateFrom: "2026-07-02", dateTo: "2026-07-02" },
    });
    await insertReadyDocumentWithChunk({
      workspaceId: otherWorkspaceId,
      sourceId: null,
      title: "Other Workspace Event",
      metadata: { dateFrom: "2026-07-02", dateTo: "2026-07-02" },
    });

    const allSources = await repository.findUpcoming({
      workspaceId,
      today: "2026-07-02",
      topK: 10,
    });

    expect(allSources.map((candidate) => candidate.chunkId)).toEqual([ongoing, otherSource, soon, later]);
    expect(allSources.map((candidate) => candidate.chunkId)).not.toContain(past);

    const scoped = await repository.findUpcoming({
      workspaceId,
      today: "2026-07-02",
      topK: 10,
      sourceFilter: {
        constrained: true,
        sourceIds: [sourceId],
        includeUnassignedDocuments: false,
      },
    });

    expect(scoped.map((candidate) => candidate.chunkId)).toEqual([ongoing, soon, later]);
  });

  it("omits disabled and expired documents but keeps a future expiry", async () => {
    const excludedWorkspaceId = randomUUID();
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [excludedWorkspaceId, accountId, "Excluded Workspace", `temporal-${excludedWorkspaceId}`],
    );

    const included = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Included Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
    });
    const excluded = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Excluded Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalEnabled: false,
    });
    const expired = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Expired Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    const futureExpiry = await insertReadyDocumentWithChunk({
      workspaceId: excludedWorkspaceId,
      sourceId: null,
      title: "Future Expiry Event",
      metadata: { dateFrom: "2026-07-04", dateTo: "2026-07-04" },
      retrievalExpiresAt: "2999-01-01T00:00:00.000Z",
    });

    const candidates = await repository.findUpcoming({
      workspaceId: excludedWorkspaceId,
      today: "2026-07-02",
      topK: 10,
    });
    const chunkIds = candidates.map((candidate) => candidate.chunkId);

    expect(chunkIds).toContain(included);
    expect(chunkIds).toContain(futureExpiry);
    expect(chunkIds).not.toContain(excluded);
    expect(chunkIds).not.toContain(expired);
  });
});
