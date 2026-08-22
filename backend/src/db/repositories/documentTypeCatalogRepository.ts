import {
  DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION,
  type DocumentTypeCatalogRecord,
  type DocumentTypeCatalogRepositoryPort,
  type OperatorDocumentTypeDefinition,
  type RetiredDocumentTypeFieldIdentity,
} from "../../modules/documentTypes/contracts/documentTypeCatalog.js";
import {
  parseDisabledBuiltInTypeKeys,
  parseOperatorDocumentTypes,
  parseRetiredDocumentTypeFields,
} from "../../modules/documentTypes/public.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface DocumentTypeCatalogRow {
  workspace_id: string;
  revision: string;
  types: unknown;
  retired_fields: unknown;
  disabled_built_in_types: unknown;
  created_at: Date;
  updated_at: Date;
}

const documentTypeCatalogColumns = [
  "workspace_id",
  "revision",
  "types",
  "retired_fields",
  "disabled_built_in_types",
  "created_at",
  "updated_at",
] as const;

const mapCatalog = (row: DocumentTypeCatalogRow): DocumentTypeCatalogRecord => ({
  workspaceId: row.workspace_id,
  revision: String(row.revision),
  types: parseOperatorDocumentTypes(row.types),
  retiredFields: parseRetiredDocumentTypeFields(row.retired_fields),
  disabledBuiltInTypeKeys: parseDisabledBuiltInTypeKeys(row.disabled_built_in_types),
});

const nextRevision = (current: string): string => String(BigInt(current) + 1n);

export class DocumentTypeCatalogRepository implements DocumentTypeCatalogRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByWorkspaceId(workspaceId: string): Promise<DocumentTypeCatalogRecord | null> {
    const row = await this.db
      .selectFrom("document_type_catalogs")
      .select(documentTypeCatalogColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return row ? mapCatalog(row as DocumentTypeCatalogRow) : null;
  }

  /**
   * Conditional write. Resolves `null` when the caller's expected revision no
   * longer matches, so a second operator reloads instead of silently
   * overwriting the first.
   */
  async save(input: {
    workspaceId: string;
    expectedRevision: string;
    types: readonly OperatorDocumentTypeDefinition[];
    retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
    disabledBuiltInTypeKeys: readonly string[];
  }): Promise<DocumentTypeCatalogRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("document_type_catalogs")
        .select(documentTypeCatalogColumns)
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();

      // A workspace with no row reads as the default catalog at revision 1, so
      // the first save is conditional on that revision like any other.
      const currentRevision = existing
        ? String((existing as DocumentTypeCatalogRow).revision)
        : DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION;
      if (currentRevision !== input.expectedRevision) {
        return null;
      }

      const revision = nextRevision(currentRevision);
      const row = await trx
        .insertInto("document_type_catalogs")
        .values({
          workspace_id: input.workspaceId,
          revision,
          types: toJsonb([...input.types]),
          retired_fields: toJsonb([...input.retiredFields]),
          disabled_built_in_types: toJsonb([...input.disabledBuiltInTypeKeys]),
        })
        .onConflict((oc) =>
          oc
            .column("workspace_id")
            .doUpdateSet((eb) => ({
              revision: eb.ref("excluded.revision"),
              types: eb.ref("excluded.types"),
              retired_fields: eb.ref("excluded.retired_fields"),
              disabled_built_in_types: eb.ref("excluded.disabled_built_in_types"),
              updated_at: currentTimestamp(),
            }))
            // Two first-saves race past the row lock (there is no row to lock
            // yet); the conflict path re-checks the stored revision so the
            // loser conflicts instead of overwriting the winner.
            .where("document_type_catalogs.revision", "=", input.expectedRevision),
        )
        .returning(documentTypeCatalogColumns)
        .executeTakeFirst();

      return row ? mapCatalog(row as DocumentTypeCatalogRow) : null;
    });
  }
}
