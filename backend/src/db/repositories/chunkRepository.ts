import type { ChunkRecord, ChunkRepositoryPort } from "../../modules/documents/services/documentIngestionService.js";
import type { Database } from "../../shared/infra/database.js";

export class ChunkRepository implements ChunkRepositoryPort {
  constructor(private readonly database: Database) {}

  async replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    await this.database.withTransaction(async (client) => {
      await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO chunks (id, document_id, account_id, chunk_index, content, embedding, start_offset, end_offset)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
          [
            chunk.id,
            chunk.documentId,
            chunk.accountId,
            chunk.chunkIndex,
            chunk.content,
            `[${chunk.embedding.join(",")}]`,
            chunk.startOffset,
            chunk.endOffset,
          ],
        );
      }
    });
  }
}
