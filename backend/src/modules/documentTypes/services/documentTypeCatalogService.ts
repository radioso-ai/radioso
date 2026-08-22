import type { AuditService } from "../../audit/contracts/index.js";
import { conflict } from "../../../shared/domain/errors.js";
import {
  defaultDocumentTypeCatalogRecord,
  type DocumentTypeCatalog,
  type DocumentTypeCatalogReaderPort,
  type DocumentTypeCatalogRecord,
  type DocumentTypeCatalogRepositoryPort,
  type DocumentTypeCatalogWriteInput,
  type DocumentTypeFieldValueType,
  type EnabledDocumentTypesSnapshot,
} from "../contracts/documentTypeCatalog.js";
import {
  mergeDocumentTypeCatalog,
  toDeclaredMetadataFields,
  toEnabledDocumentTypesSnapshot,
} from "../domain/documentTypeCatalogReadModel.js";
import { validateDocumentTypeCatalogWrite } from "../domain/documentTypeCatalogValidation.js";

export class DocumentTypeCatalogService implements DocumentTypeCatalogReaderPort {
  constructor(
    private readonly repository: DocumentTypeCatalogRepositoryPort,
    private readonly auditService: AuditService,
  ) {}

  private async readRecord(workspaceId: string): Promise<DocumentTypeCatalogRecord> {
    return (await this.repository.findByWorkspaceId(workspaceId)) ?? defaultDocumentTypeCatalogRecord(workspaceId);
  }

  async getCatalog(workspaceId: string): Promise<DocumentTypeCatalog> {
    return mergeDocumentTypeCatalog(await this.readRecord(workspaceId));
  }

  /** Narrow read port for enrichment: enabled types plus the revision they came from. */
  async listEnabledTypes(workspaceId: string): Promise<EnabledDocumentTypesSnapshot> {
    return toEnabledDocumentTypesSnapshot(await this.readRecord(workspaceId));
  }

  /**
   * Narrow read port for the metadata-rule field suggestions: which keys the
   * catalog declares and under which value type, without a document scan.
   */
  async listDeclaredMetadataFields(
    workspaceId: string,
  ): Promise<readonly { key: string; valueType: DocumentTypeFieldValueType }[]> {
    return toDeclaredMetadataFields(await this.readRecord(workspaceId));
  }

  async replaceCatalog(
    workspaceId: string,
    input: DocumentTypeCatalogWriteInput,
  ): Promise<DocumentTypeCatalog> {
    const previous = await this.readRecord(workspaceId);
    // Validation runs against the catalog the write was based on, so a stale
    // expected revision is rejected before any tombstone is derived from it.
    if (previous.revision !== input.expectedRevision) {
      throw this.staleRevision(previous.revision);
    }

    const validated = validateDocumentTypeCatalogWrite({ previous, next: input });

    let saved: DocumentTypeCatalogRecord | null;
    try {
      saved = await this.repository.save({
        workspaceId,
        expectedRevision: input.expectedRevision,
        types: validated.types,
        retiredFields: validated.retiredFields,
        disabledBuiltInTypeKeys: validated.disabledBuiltInTypeKeys,
      });
    } catch (error) {
      await this.recordAudit(workspaceId, "failure", previous);
      throw error;
    }

    if (!saved) {
      await this.recordAudit(workspaceId, "failure", previous);
      throw this.staleRevision((await this.readRecord(workspaceId)).revision);
    }

    await this.recordAudit(workspaceId, "success", saved);
    return mergeDocumentTypeCatalog(saved);
  }

  private staleRevision(currentRevision: string) {
    return conflict(
      `The document type catalog changed since it was loaded (current revision ${currentRevision}). Reload before saving again.`,
    );
  }

  private async recordAudit(
    workspaceId: string,
    eventStatus: "success" | "failure",
    record: DocumentTypeCatalogRecord,
  ): Promise<void> {
    try {
      await this.auditService.record({
        workspaceId,
        eventType: "document_type_catalog.update",
        eventStatus,
        // Counts only: type keys, labels, and instructions are operator content.
        metadata: {
          revision: record.revision,
          typeCount: record.types.length,
          fieldCount: record.types.reduce((total, type) => total + type.fields.length, 0),
          disabledBuiltInTypeCount: record.disabledBuiltInTypeKeys.length,
          retiredFieldCount: record.retiredFields.length,
        },
      });
    } catch {
      // Audit logging must not turn a successful catalog save into a 500.
    }
  }
}
