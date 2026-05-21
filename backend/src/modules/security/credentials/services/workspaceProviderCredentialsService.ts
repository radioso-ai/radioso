import {
  decryptField,
  encryptField,
} from "../../../../shared/infra/crypto/fieldEncryption.js";
import { badRequest, AppError } from "../../../../shared/domain/errors.js";
import type {
  WorkspaceProviderCredentialSummary,
  WorkspaceProviderCredentialsRepositoryPort,
} from "../../../../db/repositories/workspaceProviderCredentialsRepository.js";
import type { AuditPort } from "../../../audit/contracts/index.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import {
  ProviderConfigurationError,
  type LlmProviderName,
} from "../../../../shared/infra/llm/providerTypes.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

export interface WorkspaceCredentialsEncryptionConfig {
  /** Base64-encoded 32-byte key. Undefined when the operator has not configured one. */
  key: string | undefined;
}

export interface SetApiKeyInput {
  workspaceId: string;
  provider: LlmProviderName;
  apiKey: string;
  actor: { accountId: string };
}

export interface CredentialActor {
  accountId: string;
}

export class EncryptionNotConfiguredError extends AppError {
  constructor() {
    super(
      503,
      "encryption_not_configured",
      `${KEY_NAME} is not configured; cannot store provider credentials. Set ${KEY_NAME} to enable secret writes.`,
    );
  }
}

export class WorkspaceProviderCredentialsService {
  private decryptErrorListener: ((error: unknown, provider: LlmProviderName) => void) | undefined;

  constructor(
    private readonly repository: WorkspaceProviderCredentialsRepositoryPort,
    private readonly auditService: AuditPort,
    private readonly encryption: WorkspaceCredentialsEncryptionConfig,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  isEncryptionConfigured(): boolean {
    return typeof this.encryption.key === "string" && this.encryption.key.length > 0;
  }

  onDecryptError(listener: (error: unknown, provider: LlmProviderName) => void): void {
    this.decryptErrorListener = listener;
  }

  async setApiKey(input: SetApiKeyInput): Promise<void> {
    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      throw badRequest("api key must not be empty");
    }
    if (!this.isEncryptionConfigured()) {
      await this.recordAudit({
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType: "workspace_provider_credentials.set",
        eventStatus: "failure",
        provider: input.provider,
        reason: "encryption_not_configured",
      });
      throw new EncryptionNotConfiguredError();
    }

    try {
      const ciphertext = encryptField(apiKey, this.encryption.key!, { keyName: KEY_NAME });
      await this.repository.upsert({
        workspaceId: input.workspaceId,
        provider: input.provider,
        ciphertext,
      });
      await this.recordAudit({
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType: "workspace_provider_credentials.set",
        eventStatus: "success",
        provider: input.provider,
      });
    } catch (error) {
      if (!(error instanceof EncryptionNotConfiguredError)) {
        await this.recordAudit({
          accountId: input.actor.accountId,
          workspaceId: input.workspaceId,
          eventType: "workspace_provider_credentials.set",
          eventStatus: "failure",
          provider: input.provider,
          reason: "write_failed",
        });
      }
      throw error;
    }
  }

  async getApiKey(workspaceId: string, provider: LlmProviderName): Promise<string | undefined> {
    const record = await this.repository.findByWorkspaceAndProvider(workspaceId, provider);
    if (!record) {
      // No stored workspace credential — callers fall back to the env-default key.
      return undefined;
    }
    if (!this.isEncryptionConfigured()) {
      // A row exists but the master key was removed; do NOT silently use the env key,
      // because the workspace operator explicitly opted into a BYOK setup. Force an
      // actionable misconfiguration error.
      throw new ProviderConfigurationError(
        `Workspace credential for "${provider}" is stored but cannot be read because ${KEY_NAME} is not configured. Set ${KEY_NAME} on the backend, or remove the workspace credential.`,
        {
          kind: "credential_unreadable",
          provider,
          setting: KEY_NAME,
          remediation: `Set ${KEY_NAME} on the backend and restart Radioso, or remove the workspace credential at Settings → Credentials and re-enter it.`,
        },
      );
    }
    try {
      return decryptField(record.ciphertext, this.encryption.key!, { keyName: KEY_NAME });
    } catch (error) {
      this.decryptErrorListener?.(error, provider);
      throw new ProviderConfigurationError(
        `Workspace credential for "${provider}" could not be decrypted. The ${KEY_NAME} value most likely rotated since the credential was stored; re-enter the API key or restore the previous ${KEY_NAME}.`,
        {
          kind: "credential_unreadable",
          provider,
          setting: KEY_NAME,
          remediation: `Re-enter the API key at Settings → Credentials, or restore the previous ${KEY_NAME} value.`,
        },
      );
    }
  }

  async removeApiKey(
    workspaceId: string,
    provider: LlmProviderName,
    actor: CredentialActor,
  ): Promise<boolean> {
    const removed = await this.repository.remove(workspaceId, provider);
    if (removed) {
      await this.recordAudit({
        accountId: actor.accountId,
        workspaceId,
        eventType: "workspace_provider_credentials.remove",
        eventStatus: "success",
        provider,
      });
    }
    return removed;
  }

  async listConfigured(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]> {
    return this.repository.listByWorkspace(workspaceId);
  }

  private async recordAudit(input: {
    accountId?: string;
    workspaceId: string;
    eventType: string;
    eventStatus: "success" | "failure";
    provider: LlmProviderName;
    reason?: string;
  }): Promise<void> {
    try {
      await this.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        eventStatus: input.eventStatus,
        metadata: {
          provider: input.provider,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    } catch (error) {
      // Audit logging must never turn a credential write into a 500, but ops needs
      // a signal that the audit pipeline broke — credential gaps are exactly the
      // kind of silent failure security teams care about. Payload is keyless.
      this.logger?.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          eventType: input.eventType,
          eventStatus: input.eventStatus,
          provider: input.provider,
        },
        "Failed to record credential audit event",
      );
    }
  }
}
