import {
  decryptField,
  encryptField,
} from "../../../../shared/infra/crypto/fieldEncryption.js";
import { badRequest, notFound, AppError } from "../../../../shared/domain/errors.js";
import type {
  WorkspaceCredentialProvider,
  WorkspaceProviderCredentialSummary,
  WorkspaceProviderCredentialsRepositoryPort,
} from "../../../../db/repositories/workspaceProviderCredentialsRepository.js";
import type { AuditPort } from "../../../audit/contracts/index.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import { ProviderConfigurationError, type OpenAIDataResidency } from "../../../../shared/infra/llm/providerTypes.js";

/** Residency is an OpenAI concept; every other provider's row keeps the column's default. */
const RESIDENCY_PROVIDER: WorkspaceCredentialProvider = "openai";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

export interface WorkspaceCredentialsEncryptionConfig {
  /** Base64-encoded 32-byte key. Undefined when the operator has not configured one. */
  key: string | undefined;
}

interface ProviderCredentialFailureRecoveryPort {
  requeueProviderCredentialFailures(workspaceId: string, limit?: number): Promise<number>;
}

interface SetApiKeyInput {
  workspaceId: string;
  provider: WorkspaceCredentialProvider;
  apiKey: string;
  /** Omitted keeps the credential's existing residency (or the default, `global`, on first save). */
  residency?: OpenAIDataResidency;
  actor: { accountId: string };
}

interface SetResidencyInput {
  workspaceId: string;
  provider: WorkspaceCredentialProvider;
  residency: OpenAIDataResidency;
  actor: { accountId: string };
}

interface CredentialActor {
  accountId: string;
}

const assertResidencyProvider = (provider: WorkspaceCredentialProvider): void => {
  if (provider !== RESIDENCY_PROVIDER) {
    throw badRequest(`residency is only configurable for the "${RESIDENCY_PROVIDER}" provider`);
  }
};

class EncryptionNotConfiguredError extends AppError {
  constructor() {
    super(
      503,
      "encryption_not_configured",
      `${KEY_NAME} is not configured; cannot store provider credentials. Set ${KEY_NAME} to enable secret writes.`,
    );
  }
}

export class WorkspaceProviderCredentialsService {
  private decryptErrorListener: ((error: unknown, provider: WorkspaceCredentialProvider) => void) | undefined;
  private changeListener: ((change: { workspaceId: string; provider: WorkspaceCredentialProvider }) => Promise<void>) | undefined;

  constructor(
    private readonly repository: WorkspaceProviderCredentialsRepositoryPort,
    private readonly auditService: AuditPort,
    private readonly encryption: WorkspaceCredentialsEncryptionConfig,
    private readonly logger?: Pick<AppLogger, "warn">,
    private readonly recovery?: ProviderCredentialFailureRecoveryPort,
  ) {}

  isEncryptionConfigured(): boolean {
    return typeof this.encryption.key === "string" && this.encryption.key.length > 0;
  }

  onDecryptError(listener: (error: unknown, provider: WorkspaceCredentialProvider) => void): void {
    this.decryptErrorListener = listener;
  }

  /**
   * Called after a key is stored or removed, so what reads the key's presence can drop what it
   * cached from it. Best effort: a listener that fails is logged and never fails the write.
   */
  onChange(listener: (change: { workspaceId: string; provider: WorkspaceCredentialProvider }) => Promise<void>): void {
    this.changeListener = listener;
  }

  private async notifyChange(workspaceId: string, provider: WorkspaceCredentialProvider): Promise<void> {
    try {
      await this.changeListener?.({ workspaceId, provider });
    } catch (error) {
      this.logger?.warn(
        { workspaceId, provider, errorClass: error instanceof Error ? error.name : typeof error },
        "Workspace credential change listener failed",
      );
    }
  }

  async setApiKey(input: SetApiKeyInput): Promise<void> {
    const apiKey = input.apiKey.trim();
    if (apiKey.length === 0) {
      throw badRequest("api key must not be empty");
    }
    if (input.residency !== undefined) {
      assertResidencyProvider(input.provider);
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
        residency: input.residency,
      });
      this.recoverProviderCredentialFailures(input.workspaceId);
      await this.recordAudit({
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType: "workspace_provider_credentials.set",
        eventStatus: "success",
        provider: input.provider,
        residency: input.residency,
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
    await this.notifyChange(input.workspaceId, input.provider);
  }

  /** Changes a stored OpenAI credential's residency alone; the key itself is unchanged. */
  async setResidency(input: SetResidencyInput): Promise<void> {
    assertResidencyProvider(input.provider);
    const updated = await this.repository.updateResidency(input.workspaceId, input.provider, input.residency);
    if (!updated) {
      await this.recordAudit({
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType: "workspace_provider_credentials.set",
        eventStatus: "failure",
        provider: input.provider,
        reason: "no_credential",
      });
      throw notFound(`No stored credential for provider "${input.provider}"`);
    }
    await this.recordAudit({
      accountId: input.actor.accountId,
      workspaceId: input.workspaceId,
      eventType: "workspace_provider_credentials.set",
      eventStatus: "success",
      provider: input.provider,
      residency: input.residency,
    });
    await this.notifyChange(input.workspaceId, input.provider);
  }

  /** The workspace's own OpenAI credential's authored residency; `global` when none is stored. */
  async getOpenAIResidency(workspaceId: string): Promise<OpenAIDataResidency> {
    const record = await this.repository.findByWorkspaceAndProvider(workspaceId, RESIDENCY_PROVIDER);
    return record?.residency ?? "global";
  }

  private recoverProviderCredentialFailures(workspaceId: string): void {
    if (!this.recovery) return;
    void (async () => {
      try {
        while (await this.recovery!.requeueProviderCredentialFailures(workspaceId, 100) === 100) {
          // Each transaction claims a bounded, revision-fenced batch.
        }
      } catch (error) {
        this.logger?.warn({ workspaceId, err: error instanceof Error ? error.message : String(error) }, "Provider credential recovery failed");
      }
    })();
  }

  async getApiKey(workspaceId: string, provider: WorkspaceCredentialProvider): Promise<string | undefined> {
    const record = await this.repository.findByWorkspaceAndProvider(workspaceId, provider);
    if (!record) {
      // No stored workspace credential. A model provider caller may fall back to its deployment
      // key; a voice vendor has none, so its caller starts no session.
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

  /** Presence only. Reads no plaintext, so it works without the master key. */
  async hasCredentials(workspaceId: string, provider: WorkspaceCredentialProvider): Promise<boolean> {
    const record = await this.repository.findByWorkspaceAndProvider(workspaceId, provider);
    return record !== null;
  }

  async removeApiKey(
    workspaceId: string,
    provider: WorkspaceCredentialProvider,
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
      await this.notifyChange(workspaceId, provider);
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
    provider: WorkspaceCredentialProvider;
    reason?: string;
    /** The residency an operator chose in this write, when the write touched it. Not a secret. */
    residency?: OpenAIDataResidency;
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
          ...(input.residency ? { residency: input.residency } : {}),
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
