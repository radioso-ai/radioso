import type {
  EnrichmentReplyStore,
  StoredEnrichmentReply,
} from "../../modules/documents/domain/enrichment/enrichmentReplyStore.js";
import { toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

const readStoredReply = (value: unknown): StoredEnrichmentReply | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.requestFingerprint === "string" && typeof record.model === "string" && "output" in record
    ? { requestFingerprint: record.requestFingerprint, model: record.model, output: record.output }
    : null;
};

/**
 * `documents.enrichment_reply`: a document's last usable extraction reply.
 * Saving it is not an edit of the document, so `updated_at` and the revision
 * stay as they are.
 */
export class DocumentEnrichmentReplyRepository implements EnrichmentReplyStore {
  constructor(private readonly db: Db) {}

  async find(document: { workspaceId: string; documentId: string }): Promise<StoredEnrichmentReply | null> {
    const row = await this.db
      .selectFrom("documents")
      .select("enrichment_reply")
      .where("id", "=", document.documentId)
      .where("workspace_id", "=", document.workspaceId)
      .executeTakeFirst();
    return readStoredReply(row?.enrichment_reply);
  }

  async save(document: { workspaceId: string; documentId: string }, reply: StoredEnrichmentReply): Promise<void> {
    await this.db
      .updateTable("documents")
      .set({ enrichment_reply: toJsonb(reply) })
      .where("id", "=", document.documentId)
      .where("workspace_id", "=", document.workspaceId)
      .execute();
  }
}
