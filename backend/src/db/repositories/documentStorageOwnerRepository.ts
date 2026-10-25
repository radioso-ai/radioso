import { sql } from "kysely";

import type { DocumentStorageOwnersPort } from "../../modules/documents/contracts/index.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/** Which workspaces exist, and which hold uploaded files, for removing the stored files of deleted ones. */
export class DocumentStorageOwnerRepository implements DocumentStorageOwnersPort {
  constructor(private readonly db: Db) {}

  async existingWorkspaceIds(workspaceIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (workspaceIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("workspaces")
      .select("id")
      .where("id", "in", [...workspaceIds])
      .execute();
    return new Set(rows.map((row) => row.id));
  }

  async workspacesWithUploadedFiles(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom("documents")
      .select("workspace_id")
      .where("source_kind", "=", "uploaded_file")
      .where("source_storage_object", "is not", null)
      .groupBy("workspace_id")
      .orderBy(sql`max(created_at)`, "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => row.workspace_id);
  }
}
