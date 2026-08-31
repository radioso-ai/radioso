import {
  activeEmbeddingModelFromPersisted,
  defaultIngestionSettings,
  EMBEDDING_MODEL_DEFAULT,
  type EmbeddingModelId,
  embeddingModelIds,
  isEmbeddingModelId,
  type IngestionSettingsRecord,
  type IngestionSettingsWriteInput,
  type ValidatedIngestionSettingsInput,
  validateIngestionSettings,
} from "../domain/ingestionSettings.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type {
  EmbeddingModelTransitionPort,
  EmbeddingModelTransitionState,
  IngestionSettingsRepositoryPort,
} from "../contracts/services.js";
import {
  badRequest,
  serviceUnavailable,
} from "../../../shared/domain/errors.js";

interface IngestionSettingsSnapshot {
  settings: IngestionSettingsRecord;
  revision: string | null;
}

export class IngestionSettingsService {
  constructor(
    private readonly repository: IngestionSettingsRepositoryPort,
    private readonly auditService: AuditService,
    private readonly supportedEmbeddingModels?: readonly EmbeddingModelId[],
    private readonly embeddingTransitions?: EmbeddingModelTransitionPort,
  ) {}

  async getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord> {
    const current = await this.findSettingsSnapshot(workspaceId);
    if (current) {
      const existing = await this.resolveEffectiveTransitionState(
        workspaceId,
        current.settings,
        current.revision,
      );
      return {
        ...existing,
        ...this.validateWithPreservedActiveModel(
          existing,
          existing.embeddingModel,
        ),
      };
    }

    const defaults = defaultIngestionSettings(workspaceId);
    return this.repository.upsert(workspaceId, defaults);
  }

  private async resolveTransitionStateWithLegacyRepair(
    workspaceId: string,
    settings: IngestionSettingsRecord,
  ): Promise<EmbeddingModelTransitionState | null> {
    if (!this.embeddingTransitions) {
      return null;
    }

    const transition = await this.embeddingTransitions.getState(workspaceId);
    if (
      !settings.pendingEmbeddingModel
      || !isEmbeddingModelId(settings.pendingEmbeddingModel)
      || (
        transition
        && (
          transition.pendingModel
          || transition.status !== "idle"
        )
      )
    ) {
      return transition;
    }

    return this.embeddingTransitions.start({
      workspaceId,
      activeModel: settings.embeddingModel,
      targetModel: settings.pendingEmbeddingModel,
    });
  }

  private async resolveEffectiveTransitionState(
    workspaceId: string,
    settings: IngestionSettingsRecord,
    revision: string | null,
  ): Promise<IngestionSettingsRecord> {
    const transition = await this.resolveTransitionStateWithLegacyRepair(
      workspaceId,
      settings,
    );
    if (!transition) {
      return settings;
    }

    const effective = this.applyTransitionState(settings, transition);
    if (
      transition.status !== "failed"
      || transition.pendingModel
      || !settings.pendingEmbeddingModel
      || !revision
      || !this.repository.clearPendingEmbeddingModel
    ) {
      return effective;
    }

    const synchronized = await this.repository.clearPendingEmbeddingModel(
      workspaceId,
      settings.pendingEmbeddingModel,
      revision,
    );
    if (synchronized) {
      return this.applyTransitionState(synchronized, transition);
    }

    // A compare-and-clear miss means another settings write won the race.
    // Return its durable state rather than overlaying stale transition data.
    return (await this.findSettingsSnapshot(workspaceId))?.settings ?? effective;
  }

  private async findSettingsSnapshot(
    workspaceId: string,
  ): Promise<IngestionSettingsSnapshot | null> {
    if (this.repository.findVersionedByWorkspaceId) {
      return this.repository.findVersionedByWorkspaceId(workspaceId);
    }
    const settings = await this.repository.findByWorkspaceId(workspaceId);
    return settings ? { settings, revision: null } : null;
  }

  async updateForWorkspace(
    workspaceId: string,
    input: IngestionSettingsWriteInput,
    options?: { expectedUpdatedAt?: Date },
  ): Promise<IngestionSettingsRecord> {
    try {
      const existing = await this.findSettingsSnapshot(workspaceId);
      const baseline = existing
        ? await this.resolveEffectiveTransitionState(
            workspaceId,
            existing.settings,
            existing.revision,
          )
        : defaultIngestionSettings(workspaceId);
      const requestedEmbeddingModel = input.embeddingModel;
      const transitionTarget = this.resolveTransitionTarget(
        baseline,
        requestedEmbeddingModel,
      );
      this.assertRequestedEmbeddingModelCanRun(baseline, transitionTarget);
      this.assertEmbeddingTransitionCanStart(baseline, transitionTarget);
      const embeddingTransition = transitionTarget
        ? this.transitionFields(await this.startAndReconcileTransition({
            workspaceId,
            activeModel: baseline.embeddingModel,
            targetModel: transitionTarget,
          }))
        : {
            embeddingModel: baseline.embeddingModel,
            pendingEmbeddingModel: baseline.pendingEmbeddingModel,
          };
      const settings = await this.repository.upsert(
        workspaceId,
        this.validateWithPreservedActiveModel({
          ...baseline,
          ...input,
          ...embeddingTransition,
        }, embeddingTransition.embeddingModel),
        options,
      );
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
    if (!this.embeddingTransitions) {
      return null;
    }
    const transition = await this.embeddingTransitions.reconcile(workspaceId);
    if (!transition) {
      return null;
    }
    const baseline = await this.repository.findByWorkspaceId(workspaceId);
    if (!baseline) {
      return null;
    }
    return this.persistTransitionState(workspaceId, baseline, transition);
  }

  async cancelPendingEmbeddingModel(workspaceId: string): Promise<IngestionSettingsRecord> {
    const baseline = await this.getForWorkspace(workspaceId);
    if (!baseline.pendingEmbeddingModel) {
      return baseline;
    }

    const transition = await this.requireEmbeddingTransitions().cancel(workspaceId);
    const settings = await this.persistTransitionState(
      workspaceId,
      baseline,
      transition,
    );

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

  private resolveTransitionTarget(
    baseline: IngestionSettingsRecord,
    requestedEmbeddingModel: string | undefined,
  ): EmbeddingModelId | undefined {
    if (
      !requestedEmbeddingModel ||
      requestedEmbeddingModel === baseline.embeddingModel
    ) {
      return undefined;
    }
    if (!isEmbeddingModelId(requestedEmbeddingModel)) {
      throw badRequest("embeddingModel must be a supported embedding model");
    }
    return requestedEmbeddingModel;
  }

  private validateWithPreservedActiveModel(
    input: IngestionSettingsWriteInput & {
      pendingEmbeddingModel?: EmbeddingModelId | null;
    },
    activeEmbeddingModel: string,
  ): ValidatedIngestionSettingsInput {
    if (isEmbeddingModelId(activeEmbeddingModel)) {
      return validateIngestionSettings({
        ...input,
        embeddingModel: activeEmbeddingModel,
      });
    }

    const validated = validateIngestionSettings({
      ...input,
      embeddingModel: EMBEDDING_MODEL_DEFAULT,
    });
    return {
      ...validated,
      // This persisted value is preserved only for an unchanged legacy echo.
      // It is never accepted as a new embedding-model selection.
      embeddingModel: activeEmbeddingModelFromPersisted(activeEmbeddingModel),
    };
  }

  private requireEmbeddingTransitions(): EmbeddingModelTransitionPort {
    if (this.embeddingTransitions) {
      return this.embeddingTransitions;
    }
    throw serviceUnavailable(
      "Embedding model transitions are temporarily unavailable",
    );
  }

  private async startAndReconcileTransition(input: {
    workspaceId: string;
    activeModel: string;
    targetModel: EmbeddingModelId;
  }): Promise<EmbeddingModelTransitionState> {
    const transitions = this.requireEmbeddingTransitions();
    const started = await transitions.start(input);
    return await transitions.reconcile(input.workspaceId) ?? started;
  }

  private transitionFields(
    transition: EmbeddingModelTransitionState,
  ): Pick<IngestionSettingsRecord, "embeddingModel" | "pendingEmbeddingModel"> {
    if (
      transition.pendingModel
      && transition.pendingModel === transition.activeModel
    ) {
      throw new Error(
        "Embedding transition state cannot expose the active model as pending",
      );
    }
    return {
      embeddingModel: activeEmbeddingModelFromPersisted(transition.activeModel),
      pendingEmbeddingModel: transition.pendingModel,
    };
  }

  private applyTransitionState(
    settings: IngestionSettingsRecord,
    transition: EmbeddingModelTransitionState,
  ): IngestionSettingsRecord {
    return {
      ...settings,
      ...this.transitionFields(transition),
    };
  }

  private persistTransitionState(
    workspaceId: string,
    settings: IngestionSettingsRecord,
    transition: EmbeddingModelTransitionState,
  ): Promise<IngestionSettingsRecord> {
    const fields = this.transitionFields(transition);
    return this.repository.upsert(
      workspaceId,
      this.validateWithPreservedActiveModel({
        ...settings,
        ...fields,
      }, fields.embeddingModel),
    );
  }
}
