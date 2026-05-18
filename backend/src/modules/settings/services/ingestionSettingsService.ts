import {
  defaultIngestionSettings,
  type EmbeddingModelId,
  embeddingModelIds,
  type IngestionSettingsInput,
  type IngestionSettingsRecord,
  validateIngestionSettings,
} from "../domain/ingestionSettings.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { IngestionSettingsRepositoryPort, WorkspaceReprocessPort } from "../contracts/services.js";
import type { DocumentRepositoryPort } from "../../documents/contracts/index.js";
import { badRequest } from "../../../shared/domain/errors.js";

export class IngestionSettingsService {
  constructor(
    private readonly repository: IngestionSettingsRepositoryPort,
    private readonly auditService: AuditService,
    private readonly documentRepository?: Pick<DocumentRepositoryPort, "summarizeWorkspace">,
    private readonly supportedEmbeddingModels?: readonly EmbeddingModelId[],
    private readonly workspaceReprocessService?: WorkspaceReprocessPort,
  ) {}

  async getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord> {
    const current = await this.repository.findByWorkspaceId(workspaceId);
    const existing = current?.pendingEmbeddingModel
      ? await this.repository.promotePendingEmbeddingModelIfReady?.(workspaceId) ?? current
      : current;
    if (existing) {
      return {
        ...existing,
        ...validateIngestionSettings(existing),
      };
    }

    const defaults = defaultIngestionSettings(workspaceId);
    return this.repository.upsert(workspaceId, defaults);
  }

  async updateForWorkspace(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord> {
    try {
      const existing = await this.repository.findByWorkspaceId(workspaceId);
      const baseline = existing ?? defaultIngestionSettings(workspaceId);
      const requestedEmbeddingModel = input.embeddingModel;
      this.assertRequestedEmbeddingModelCanRun(baseline, requestedEmbeddingModel);
      this.assertEmbeddingTransitionCanStart(baseline, requestedEmbeddingModel);
      const embeddingTransition = requestedEmbeddingModel
        ? await this.resolveEmbeddingTransition(workspaceId, baseline, requestedEmbeddingModel)
        : {
            embeddingModel: baseline.embeddingModel,
            pendingEmbeddingModel: baseline.pendingEmbeddingModel,
          };
      const settings = await this.repository.upsert(
        workspaceId,
        validateIngestionSettings({
          ...baseline,
          ...input,
          ...embeddingTransition,
        }),
      );
      await this.reprocessWorkspaceForNewPendingModel(workspaceId, baseline, settings, input);
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "ingestion_settings.update",
          eventStatus: "success",
        });
      } catch {
        // Audit logging must not turn a successful settings save into a 500.
      }
      return settings;
    } catch (error) {
      try {
        await this.auditService.record({
          workspaceId,
          eventType: "ingestion_settings.update",
          eventStatus: "failure",
        });
      } catch {
        // Preserve the original write failure if failure-audit logging also breaks.
      }
      throw error;
    }
  }

  async promotePendingEmbeddingModelIfReady(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    return this.repository.promotePendingEmbeddingModelIfReady?.(workspaceId) ?? null;
  }

  async cancelPendingEmbeddingModel(workspaceId: string): Promise<IngestionSettingsRecord> {
    const baseline = await this.getForWorkspace(workspaceId);
    if (!baseline.pendingEmbeddingModel) {
      return baseline;
    }

    const cleared = await this.repository.clearPendingEmbeddingModel?.(workspaceId);
    const settings = cleared ?? {
      ...baseline,
      pendingEmbeddingModel: null,
      updatedAt: new Date(),
    };

    try {
      await this.auditService.record({
        workspaceId,
        eventType: "ingestion_settings.embedding_model_cancel",
        eventStatus: "success",
      });
    } catch {
      // Audit logging must not turn a successful cancellation into a 500.
    }
    return settings;
  }

  listSupportedEmbeddingModels(): readonly EmbeddingModelId[] {
    return this.supportedEmbeddingModels ?? embeddingModelIds;
  }

  private async resolveEmbeddingTransition(
    workspaceId: string,
    baseline: IngestionSettingsRecord,
    requestedEmbeddingModel: EmbeddingModelId,
  ): Promise<Pick<IngestionSettingsRecord, "embeddingModel" | "pendingEmbeddingModel">> {
    if (requestedEmbeddingModel === baseline.embeddingModel) {
      return {
        embeddingModel: baseline.embeddingModel,
        pendingEmbeddingModel: baseline.pendingEmbeddingModel,
      };
    }

    const hasDocuments = this.documentRepository
      ? (await this.documentRepository.summarizeWorkspace(workspaceId)).documentCount > 0
      : true;

    if (!hasDocuments) {
      return {
        embeddingModel: requestedEmbeddingModel,
        pendingEmbeddingModel: null,
      };
    }

    return {
      embeddingModel: baseline.embeddingModel,
      pendingEmbeddingModel: requestedEmbeddingModel,
    };
  }

  private assertRequestedEmbeddingModelCanRun(
    baseline: IngestionSettingsRecord,
    requestedEmbeddingModel: EmbeddingModelId | undefined,
  ): void {
    if (!requestedEmbeddingModel || requestedEmbeddingModel === baseline.embeddingModel) {
      return;
    }

    if (!this.supportedEmbeddingModels || this.supportedEmbeddingModels.includes(requestedEmbeddingModel)) {
      return;
    }

    throw badRequest(`embeddingModel ${requestedEmbeddingModel} requires a configured embedding provider`);
  }

  private assertEmbeddingTransitionCanStart(
    baseline: IngestionSettingsRecord,
    requestedEmbeddingModel: EmbeddingModelId | undefined,
  ): void {
    if (!requestedEmbeddingModel || requestedEmbeddingModel === baseline.embeddingModel) {
      return;
    }

    if (!baseline.pendingEmbeddingModel || requestedEmbeddingModel === baseline.pendingEmbeddingModel) {
      return;
    }

    throw badRequest(`embeddingModel change already pending for ${baseline.pendingEmbeddingModel}`);
  }

  private async reprocessWorkspaceForNewPendingModel(
    workspaceId: string,
    baseline: IngestionSettingsRecord,
    settings: IngestionSettingsRecord,
    input: IngestionSettingsInput,
  ): Promise<void> {
    if (
      !settings.pendingEmbeddingModel ||
      settings.pendingEmbeddingModel === baseline.pendingEmbeddingModel ||
      !this.workspaceReprocessService
    ) {
      return;
    }

    try {
      await this.workspaceReprocessService.reprocessWorkspace(workspaceId);
    } catch (error) {
      await this.repository.upsert(workspaceId, validateIngestionSettings({
        ...settings,
        ...input,
        embeddingModel: baseline.embeddingModel,
        pendingEmbeddingModel: baseline.pendingEmbeddingModel,
      }));
      throw error;
    }
  }
}
