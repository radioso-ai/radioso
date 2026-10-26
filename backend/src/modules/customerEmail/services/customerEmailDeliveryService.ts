import type {
  CustomerEmailConnectionRecord,
  CustomerEmailConnectionRepositoryPort,
} from "../../../db/repositories/customerEmailConnectionRepository.js";
import type { CustomerEmailSkillMode, CustomerEmailSkillOutcome } from "../domain.js";
import {
  OauthNotAuthorizedError,
  resolveFreshAccessToken,
  type ResolveFreshAccessTokenInput,
} from "../../integrationOauth/public.js";
import type {
  CustomerEmailMessageInput,
  CustomerEmailProviderRegistryPort,
} from "../providers/customerEmailProvider.js";
import { CustomerEmailProviderRejectedError } from "../providers/customerEmailProvider.js";

interface CustomerEmailOauthCredentialLookupPort {
  findCredentialById(workspaceId: string, id: string): Promise<ResolveFreshAccessTokenInput["record"] | null>;
}

interface CustomerEmailDeliveryServiceOptions {
  connections: CustomerEmailConnectionRepositoryPort;
  oauthCredentials: CustomerEmailOauthCredentialLookupPort;
  oauthTokenRepository: ResolveFreshAccessTokenInput["repository"];
  providers: CustomerEmailProviderRegistryPort;
  encryptionKey: ResolveFreshAccessTokenInput["encryptionKey"];
  timeoutMs?: number;
  assertPublicUrl?: ResolveFreshAccessTokenInput["assertPublicUrl"];
  fetchImpl?: ResolveFreshAccessTokenInput["fetchImpl"];
  logger?: ResolveFreshAccessTokenInput["logger"];
}

interface CustomerEmailDeliveryInput {
  workspaceId: string;
  connectionId: string;
  mode: CustomerEmailSkillMode;
  /** Stable identity the provider must use to make a repeated send or draft a no-op. */
  idempotencyKey?: string;
  message: Omit<CustomerEmailMessageInput, "accessToken" | "workspaceId" | "connectionId" | "senderEmail" | "senderName" | "replyToEmail" | "idempotencyKey">;
}

export interface CustomerEmailDeliveryResult {
  outcome: CustomerEmailSkillOutcome;
  providerMessageId?: string | null;
  errorCode?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const missingCapability = (mode: CustomerEmailSkillMode): CustomerEmailDeliveryResult => ({
  outcome: "failed",
  errorCode: mode === "draft" ? "provider_draft_unavailable" : "provider_send_unavailable",
});

export class CustomerEmailDeliveryService {
  constructor(private readonly options: CustomerEmailDeliveryServiceOptions) {}

  async deliver(input: CustomerEmailDeliveryInput): Promise<CustomerEmailDeliveryResult> {
    const connection = await this.options.connections.findById(input.workspaceId, input.connectionId);
    if (!connection) return { outcome: "failed", errorCode: "connection_not_found" };
    if (connection.status === "disabled") return { outcome: "disabled_connection", errorCode: "operator_disabled" };
    if (connection.status === "needs_reauth") return { outcome: "needs_reauth", errorCode: "oauth_needs_reauth" };
    if (connection.status !== "authorized") return { outcome: "failed", errorCode: "connection_unavailable" };

    const provider = this.options.providers.get(connection.provider);
    if (!provider) return { outcome: "failed", errorCode: "provider_not_configured" };

    const method = input.mode === "draft" ? provider.createDraft?.bind(provider) : provider.sendMessage?.bind(provider);
    if (!method) return missingCapability(input.mode);

    let accessToken: string;
    try {
      const credential = await this.options.oauthCredentials.findCredentialById(input.workspaceId, connection.oauthConnectionId);
      if (!credential) return { outcome: "needs_reauth", errorCode: "oauth_connection_missing" };
      accessToken = await resolveFreshAccessToken({
        subjectId: input.workspaceId,
        record: credential,
        repository: this.options.oauthTokenRepository,
        encryptionKey: this.options.encryptionKey,
        assertPublicUrl: this.options.assertPublicUrl,
        fetchImpl: this.options.fetchImpl,
        logger: this.options.logger,
        logContext: { consumer: "customer_email" },
      });
    } catch (error) {
      if (error instanceof OauthNotAuthorizedError) {
        return this.oauthOutcome(connection);
      }
      return { outcome: "failed", errorCode: "oauth_resolution_failed" };
    }

    try {
      const result = await withTimeout(
        method({
          accessToken,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          senderEmail: connection.senderEmail,
          senderName: connection.senderName,
          replyToEmail: connection.replyToEmail,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...input.message,
        }),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      return {
        outcome: input.mode === "draft" ? "drafted" : "sent",
        providerMessageId: result.providerMessageId ?? null,
      };
    } catch (error) {
      if (error instanceof CustomerEmailProviderRejectedError) {
        return { outcome: "provider_rejected", errorCode: "provider_rejected" };
      }
      if (error instanceof TimeoutError) {
        return { outcome: "failed", errorCode: "provider_timeout" };
      }
      return { outcome: "failed", errorCode: "provider_failed" };
    }
  }

  private async oauthOutcome(connection: CustomerEmailConnectionRecord): Promise<CustomerEmailDeliveryResult> {
    if (connection.status === "disabled") {
      return { outcome: "disabled_connection", errorCode: "operator_disabled" };
    }
    await this.options.connections.update(connection.workspaceId, connection.id, {
      status: "needs_reauth",
      lastErrorCode: "oauth_needs_reauth",
    }).catch(() => undefined);
    return { outcome: "needs_reauth", errorCode: "oauth_needs_reauth" };
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Customer email provider call timed out");
    this.name = "TimeoutError";
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new TimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};
