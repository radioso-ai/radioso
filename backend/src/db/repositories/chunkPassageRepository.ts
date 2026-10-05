import type { Db } from "../../shared/infra/kysely/types.js";

interface ChunkPassage {
  chunkId: string;
  title: string;
  content: string;
}

/** Reads stored chunks back as passages: their text and their document's title. */
export class ChunkPassageRepository {
  constructor(private readonly db: Db) {}

  /** The workspace's chunks among `chunkIds`, in the order asked; a chunk no longer stored is left out. */
  async findPassages(workspaceId: string, chunkIds: readonly string[]): Promise<ChunkPassage[]> {
    if (chunkIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("chunks as c")
      .innerJoin("documents as d", "d.id", "c.document_id")
      .select(["c.id as chunk_id", "d.title", "c.content"])
      .where("c.workspace_id", "=", workspaceId)
      .where("c.id", "in", [...chunkIds])
      .execute();
    const byId = new Map(rows.map((row) => [row.chunk_id, row]));
    return chunkIds.flatMap((chunkId) => {
      const row = byId.get(chunkId);
      return row ? [{ chunkId, title: row.title, content: row.content }] : [];
    });
  }
}
