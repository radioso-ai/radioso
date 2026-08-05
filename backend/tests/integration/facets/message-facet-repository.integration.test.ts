import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { MessageFacetRepository } from "../../../src/db/repositories/messageFacetRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("MessageFacetRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new MessageFacetRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const embeddingProfileId = randomUUID();

  const createMessage = async (): Promise<string> => {
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await database.query(
      "INSERT INTO conversations (id, workspace_id) VALUES ($1, $2)",
      [conversationId, workspaceId],
    );
    await database.query(
      `INSERT INTO messages (id, conversation_id, role, content, workspace_id)
       VALUES ($1, $2, 'user', 'irrelevant', $3)`,
      [messageId, conversationId, workspaceId],
    );
    return messageId;
  };

  beforeAll(async () => {
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Message Facet Repository Test", `message-facet-repo-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)",
      [workspaceId, accountId, "Message Facet Repository Workspace", `message-facet-repo-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model, dimensions,
         distance_metric, normalization
       ) VALUES ($1, $2, 'openai', $3, $4, 3, 'cosine', 'provider_unit')`,
      [
        embeddingProfileId,
        `message-facet-repo-space-${embeddingProfileId}`,
        `message-facet-repo-endpoint-${embeddingProfileId}`,
        `message-facet-repo-model-${embeddingProfileId}`,
      ],
    );
  });

  beforeEach(async () => {
    await database.query("DELETE FROM message_facets WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM messages WHERE workspace_id = $1", [workspaceId]);
    await database.query("DELETE FROM conversations WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM embedding_spaces WHERE id = $1", [embeddingProfileId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("upsertFacet twice for one message does not create two rows", async () => {
    const messageId = await createMessage();

    await repository.upsertFacet({
      messageId,
      workspaceId,
      facetText: "first version",
      promptVersion: "v1",
    });
    await repository.upsertFacet({
      messageId,
      workspaceId,
      facetText: "second version",
      promptVersion: "v2",
    });

    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM message_facets WHERE message_id = $1",
      [messageId],
    );
    expect(rows[0]!.count).toBe("1");

    const [facet] = await repository.listForWindow({ workspaceId, messageIds: [messageId] });
    expect(facet).toEqual({
      messageId,
      facetText: "second version",
      embedding: null,
      promptVersion: "v2",
      embeddingProfileId: null,
    });
  });

  it("upsertFacet leaves embedding null on insert", async () => {
    const messageId = await createMessage();

    await repository.upsertFacet({
      messageId,
      workspaceId,
      facetText: "what shipping options exist",
      promptVersion: "v1",
    });

    const [facet] = await repository.listForWindow({ workspaceId, messageIds: [messageId] });
    expect(facet?.embedding).toBeNull();
  });

  it("re-upserting a facet clears a previously attached embedding", async () => {
    const messageId = await createMessage();
    await repository.upsertFacet({ messageId, workspaceId, facetText: "v1 text", promptVersion: "v1" });
    await repository.attachEmbedding({ messageId, embedding: [0.1, -0.2, 0.3], embeddingProfileId });

    await repository.upsertFacet({ messageId, workspaceId, facetText: "v2 text", promptVersion: "v2" });

    const [facet] = await repository.listForWindow({ workspaceId, messageIds: [messageId] });
    expect(facet?.embedding).toBeNull();
    expect(facet?.promptVersion).toBe("v2");
  });

  it("round-trips an embedding as number[] with values intact and sets dimensions", async () => {
    const messageId = await createMessage();
    await repository.upsertFacet({
      messageId,
      workspaceId,
      facetText: "how do I reset my password",
      promptVersion: "v1",
    });
    const embedding = [0.1, -0.2, 0.3];

    await repository.attachEmbedding({ messageId, embedding, embeddingProfileId });

    const [facet] = await repository.listForWindow({ workspaceId, messageIds: [messageId] });
    expect(facet?.embedding).not.toBeNull();
    expect(facet?.embedding).toHaveLength(3);
    facet!.embedding!.forEach((value, index) => {
      expect(Math.abs(value - embedding[index]!)).toBeLessThan(1e-4);
    });
    expect(facet?.embeddingProfileId).toBe(embeddingProfileId);

    const dimensionsRow = await database.query<{ dimensions: number }>(
      "SELECT dimensions FROM message_facets WHERE message_id = $1",
      [messageId],
    );
    expect(dimensionsRow[0]!.dimensions).toBe(3);
  });

  it("rejects an embedding whose width does not match its embedding profile", async () => {
    const messageId = await createMessage();
    await repository.upsertFacet({
      messageId,
      workspaceId,
      facetText: "how do I reset my password",
      promptVersion: "v1",
    });

    await expect(repository.attachEmbedding({ messageId, embedding: [0.1, -0.2], embeddingProfileId }))
      .rejects.toThrow(/dimensions do not match/);
  });

  it("listForWindow returns every requested facet that exists, scoped to the workspace", async () => {
    const messageIdWithFacet = await createMessage();
    const messageIdWithoutFacet = await createMessage();
    await repository.upsertFacet({
      messageId: messageIdWithFacet,
      workspaceId,
      facetText: "does this integrate with slack",
      promptVersion: "v1",
    });

    const results = await repository.listForWindow({
      workspaceId,
      messageIds: [messageIdWithFacet, messageIdWithoutFacet],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.messageId).toBe(messageIdWithFacet);
  });

  it("listForWindow returns an empty array for an empty messageIds list", async () => {
    const results = await repository.listForWindow({ workspaceId, messageIds: [] });
    expect(results).toEqual([]);
  });

  it("listMessageIdsMissingCurrentFacet finds ids with no facet at the current prompt version", async () => {
    const noFacet = await createMessage();
    const staleFacet = await createMessage();
    const staleEmbeddingSpace = await createMessage();
    const currentFacet = await createMessage();
    const otherEmbeddingProfileId = randomUUID();
    await database.query(
      `INSERT INTO embedding_spaces (
         id, identity_fingerprint, provider, endpoint_scope_fingerprint, model, dimensions,
         distance_metric, normalization
       ) VALUES ($1, $2, 'openai', $3, $4, 3, 'cosine', 'provider_unit')`,
      [
        otherEmbeddingProfileId,
        `message-facet-repo-space-${otherEmbeddingProfileId}`,
        `message-facet-repo-endpoint-${otherEmbeddingProfileId}`,
        `message-facet-repo-model-${otherEmbeddingProfileId}`,
      ],
    );
    await repository.upsertFacet({
      messageId: staleFacet,
      workspaceId,
      facetText: "stale text",
      promptVersion: "v1",
    });
    await repository.upsertFacet({
      messageId: currentFacet,
      workspaceId,
      facetText: "current text",
      promptVersion: "v2",
    });
    await repository.upsertFacet({
      messageId: staleEmbeddingSpace,
      workspaceId,
      facetText: "current text in old space",
      promptVersion: "v2",
    });
    await repository.attachEmbedding({ messageId: currentFacet, embedding: [0.1, 0.2, 0.3], embeddingProfileId });
    await repository.attachEmbedding({
      messageId: staleEmbeddingSpace,
      embedding: [0.1, 0.2, 0.3],
      embeddingProfileId: otherEmbeddingProfileId,
    });

    const missing = await repository.listMessageIdsMissingCurrentFacet({
      workspaceId,
      messageIds: [noFacet, staleFacet, staleEmbeddingSpace, currentFacet],
      promptVersion: "v2",
      embeddingProfileId,
    });

    expect(missing.sort()).toEqual([noFacet, staleFacet, staleEmbeddingSpace].sort());
  });

  it("listMessageIdsMissingCurrentFacet returns an empty array for an empty messageIds list", async () => {
    const missing = await repository.listMessageIdsMissingCurrentFacet({
      workspaceId,
      messageIds: [],
      promptVersion: "v1",
    });
    expect(missing).toEqual([]);
  });
});
