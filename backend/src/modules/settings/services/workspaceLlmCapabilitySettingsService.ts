import { badRequest } from "../../../shared/domain/errors.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "../contracts/llmCapability.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../contracts/services.js";
import { isKnownModelForProvider } from "../../../shared/infra/llm/knownModels.js";
import type { LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

const VALID_PROVIDERS: readonly LlmProviderName[] = [
  "openai",
  "openai-compatible",
  "gemini",
  "claude",
];

export interface WorkspaceLlmCapabilityActor {
  accountId: string;
}

export class WorkspaceLlmCapabilitySettingsService {
  constructor(
    private readonly repository: WorkspaceLlmCapabilityPreferencesRepositoryPort,
    private readonly auditService: AuditPort,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async listForWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]> {
    return this.repository.findByWorkspace(workspaceId);
  }

  async getPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
  ): Promise<WorkspaceLlmCapabilityPreference | null> {
    const all = await this.repository.findByWorkspace(workspaceId);
    return all.find((entry) => entry.capability === capability) ?? null;
  }

  async setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    input: WorkspaceLlmCapabilityPreferenceInput,
    actor: WorkspaceLlmCapabilityActor,
  ): Promise<WorkspaceLlmCapabilityPreference> {
    this.assertValidInput(input);
    try {
      // Capability preferences are stored on the retrieval_settings row. Ensure
      // the row exists before writing one of the capability columns; otherwise
      // the UPDATE would no-op on a workspace that has no ingestion/capability row.
      await this.repository.ensureRow(workspaceId);
      await this.repository.setPreference(workspaceId, capability, {
        provider: input.provider,
        model: input.model.trim(),
      });
      const updated = await this.getPreference(workspaceId, capability);
      if (!updated) {
        throw new Error("capability preference write succeeded but read returned null");
      }
      await this.recordAudit({
        accountId: actor.accountId,
        workspaceId,
        eventType: "workspace_llm_capability_settings.set",
        eventStatus: "success",
        capability,
        provider: updated.provider,
        model: updated.model,
      });
      return updated;
    } catch (error) {
      await this.recordAudit({
        accountId: actor.accountId,
        workspaceId,
        eventType: "workspace_llm_capability_settings.set",
        eventStatus: "failure",
        capability,
        provider: input.provider,
        model: input.model,
        reason: "write_failed",
      });
      throw error;
    }
  }

  async removePreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    actor: WorkspaceLlmCapabilityActor,
  ): Promise<boolean> {
    const existing = await this.getPreference(workspaceId, capability);
    if (!existing) {
      return false;
    }
    try {
      await this.repository.ensureRow(workspaceId);
      await this.repository.setPreference(workspaceId, capability, null);
      await this.recordAudit({
        accountId: actor.accountId,
        workspaceId,
        eventType: "workspace_llm_capability_settings.remove",
        eventStatus: "success",
        capability,
      });
      return true;
    } catch (error) {
      await this.recordAudit({
        accountId: actor.accountId,
        workspaceId,
        eventType: "workspace_llm_capability_settings.remove",
        eventStatus: "failure",
        capability,
        reason: "write_failed",
      });
      throw error;
    }
  }

  private assertValidInput(input: WorkspaceLlmCapabilityPreferenceInput): void {
    if (!VALID_PROVIDERS.includes(input.provider)) {
      throw badRequest(`Unknown provider: ${String(input.provider)}`);
    }
    if (typeof input.model !== "string" || input.model.trim().length === 0) {
      throw badRequest("model must not be empty");
    }
    if (!isKnownModelForProvider(input.provider, input.model.trim())) {
      throw badRequest(
        `Model "${input.model.trim()}" is not supported for provider "${input.provider}". See the workspace LLM models settings for the current catalog.`,
      );
    }
  }

  private async recordAudit(input: {
    accountId?: string;
    workspaceId: string;
    eventType: string;
    eventStatus: "success" | "failure";
    capability: WorkspaceLlmCapability;
    provider?: LlmProviderName;
    model?: string;
    reason?: string;
  }): Promise<void> {
    try {
      await this.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        eventStatus: input.eventStatus,
        metadata: {
          capability: input.capability,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    } catch (error) {
      // Audit logging must never turn a settings write into a 500, but ops needs
      // a signal that the audit pipeline broke — capability settings are
      // security-relevant (they change which provider runs).
      this.logger?.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          eventType: input.eventType,
          eventStatus: input.eventStatus,
          capability: input.capability,
        },
        "Workspace LLM capability settings audit write failed",
      );
    }
  }
}
