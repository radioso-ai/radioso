import type {
  AttachFacetEmbeddingInput,
  MessageFacetRecord,
  MessageFacetRepositoryPort,
  UpsertFacetInput,
} from "../../modules/facets/contracts.js";
import { sql } from "kysely";

import { SENSITIVE_SLOT_KEYS_METADATA_KEY } from "../../shared/domain/sensitiveTranscript.js";
import { toPgVector } from "../../shared/infra/kysely/pgVectorSql.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

// message_facets.embedding is a typeless pgvector column (codegen maps it to `string`;
// see backend/scripts/generate-kysely-types.sh). Serialize/parse the pgvector text
// literal here so every other layer works with plain number[].
const serializeVector = (embedding: readonly number[]): string => `[${embedding.join(",")}]`;

const parseVector = (value: string): number[] => {
  const normalized = value.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    throw new Error("Stored facet embedding is not a pgvector literal");
  }
  if (normalized === "[]") {
    return [];
  }
  return normalized
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part));
};

export class MessageFacetRepository implements MessageFacetRepositoryPort {
  constructor(private readonly db: Db) {}

  async upsertFacet(input: UpsertFacetInput): Promise<boolean> {
    // The facet row comes from the message row, so a message that is gone or carries a sensitive
    // value (#1543) stores nothing. FOR SHARE makes the write wait on a turn that is marking the
    // message right now and re-read the row once it commits, so a marked message is never stored
    // even when its facet was extracted while the turn ran. The marker is only ever written with
    // at least one slot key (sensitiveTurnMetadata), so its presence is the test.
    const result = await this.db
      .insertInto("message_facets")
      .columns(["message_id", "workspace_id", "facet_text", "prompt_version"])
      .expression((eb) => eb
        .selectFrom("messages")
        .select([
          "messages.id",
          "messages.workspace_id",
          eb.val(input.facetText).as("facet_text"),
          eb.val(input.promptVersion).as("prompt_version"),
        ])
        .where("messages.id", "=", input.messageId)
        .where("messages.workspace_id", "=", input.workspaceId)
        .where(sql<boolean>`NOT (messages.metadata_json ? ${SENSITIVE_SLOT_KEYS_METADATA_KEY})`)
        .forShare())
      .onConflict((oc) =>
        oc.column("message_id").doUpdateSet((eb) => ({
          facet_text: eb.ref("excluded.facet_text"),
          prompt_version: eb.ref("excluded.prompt_version"),
          // A re-extraction invalidates any embedding computed against the old facet text.
          embedding: null,
          dimensions: null,
          embedding_profile_id: null,
          updated_at: currentTimestamp(),
        })),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async attachEmbedding(input: AttachFacetEmbeddingInput): Promise<void> {
    const space = await this.db
      .selectFrom("embedding_spaces")
      .select("dimensions")
      .where("id", "=", input.embeddingProfileId)
      .executeTakeFirstOrThrow();
    if (space.dimensions !== input.embedding.length) {
      throw new Error("message_facets: embedding dimensions do not match the embedding profile");
    }
    const vector = serializeVector(input.embedding);
    await this.db
      .updateTable("message_facets")
      .set({
        embedding: toPgVector(vector),
        dimensions: input.embedding.length,
        embedding_profile_id: input.embeddingProfileId,
        updated_at: currentTimestamp(),
      })
      .where("message_id", "=", input.messageId)
      .execute();
  }

  async listForWindow(input: {
    workspaceId: string;
    messageIds: string[];
  }): Promise<MessageFacetRecord[]> {
    if (input.messageIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom("message_facets")
      .select(["message_id", "facet_text", "embedding", "prompt_version", "embedding_profile_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("message_id", "in", input.messageIds)
      .execute();
    return rows.map((row) => ({
      messageId: row.message_id,
      facetText: row.facet_text,
      embedding: row.embedding === null ? null : parseVector(row.embedding),
      promptVersion: row.prompt_version,
      embeddingProfileId: row.embedding_profile_id,
    }));
  }

  async listMessageIdsMissingCurrentFacet(input: {
    workspaceId: string;
    messageIds: string[];
    promptVersion: string;
    embeddingProfileId?: string;
  }): Promise<string[]> {
    if (input.messageIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom("message_facets")
      .select("message_id")
      .where("workspace_id", "=", input.workspaceId)
      .where("prompt_version", "=", input.promptVersion)
      .where("embedding", "is not", null)
      .$if(input.embeddingProfileId !== undefined, (qb) =>
        qb.where("embedding_profile_id", "=", input.embeddingProfileId!))
      .where("message_id", "in", input.messageIds)
      .execute();
    const current = new Set(rows.map((row) => row.message_id));
    return input.messageIds.filter((id) => !current.has(id));
  }
}
