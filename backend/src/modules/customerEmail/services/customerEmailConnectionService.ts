import type {
  CustomerEmailConnectionRecord,
  CustomerEmailConnectionRepositoryPort,
  UpdateCustomerEmailConnectionInput,
} from "../../../db/repositories/customerEmailConnectionRepository.js";
import type {
  CustomerEmailConnectionCreateInput,
  CustomerEmailConnectionSummary,
  CustomerEmailConnectionUpdateInput,
  CustomerEmailConnectionStatus,
} from "../domain.js";
import {
  assertCustomerEmailScopes,
  customerEmailOauthProviderIds,
  type CustomerEmailOauthProviderId,
} from "../oauthMailProviders.js";
import type {
  CustomerEmailProviderRegistryPort,
} from "../providers/customerEmailProvider.js";
import type { OauthConnectionService, OauthConnectionSummary } from "../../integrationOauth/public.js";
import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";

export interface CustomerEmailOauthStatusPort {
  get(workspaceId: string, connectionId: string): Promise<OauthConnectionSummary>;
}

export interface CustomerEmailConnectionServiceOptions {
  repository: CustomerEmailConnectionRepositoryPort;
  oauthConnections: CustomerEmailOauthStatusPort | Pick<OauthConnectionService, "get">;
  providers: CustomerEmailProviderRegistryPort;
}

const customerEmailProviderSet = new Set<string>(customerEmailOauthProviderIds);

const toSummary = (record: CustomerEmailConnectionRecord): CustomerEmailConnectionSummary => ({
  id: record.id,
  workspaceId: record.workspaceId,
  oauthConnectionId: record.oauthConnectionId,
  provider: record.provider,
  displayName: record.displayName,
  senderEmail: record.senderEmail,
  senderName: record.senderName,
  replyToEmail: record.replyToEmail,
  status: record.status,
  lastHealthStatus: record.lastHealthStatus,
  lastHealthCheckedAt: record.lastHealthCheckedAt?.toISOString() ?? null,
  lastErrorCode: record.lastErrorCode,
  updatedAt: record.updatedAt.toISOString(),
});

const normalizeOptional = (value: string | null | undefined): string | null | undefined =>
  value === undefined ? undefined : value;

export class CustomerEmailConnectionService {
  constructor(private readonly options: CustomerEmailConnectionServiceOptions) {}

  async list(workspaceId: string): Promise<CustomerEmailConnectionSummary[]> {
    const records = await this.options.repository.listByWorkspace(workspaceId);
    return records.map(toSummary);
  }

  async get(workspaceId: string, connectionId: string): Promise<CustomerEmailConnectionSummary> {
    return toSummary(await this.requireConnection(workspaceId, connectionId));
  }

  async create(
    workspaceId: string,
    input: CustomerEmailConnectionCreateInput,
  ): Promise<CustomerEmailConnectionSummary> {
    const oauth = await this.requireUsableOauthConnection(workspaceId, input.oauthConnectionId);
    const created = await this.options.repository.create({
      workspaceId,
      oauthConnectionId: oauth.id,
      provider: oauth.provider,
      displayName: input.displayName,
      senderEmail: input.senderEmail,
      senderName: input.senderName ?? null,
      replyToEmail: input.replyToEmail ?? null,
      status: "authorized",
    });
    return toSummary(created);
  }

  async update(
    workspaceId: string,
    connectionId: string,
    input: CustomerEmailConnectionUpdateInput,
  ): Promise<CustomerEmailConnectionSummary> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    const patch: UpdateCustomerEmailConnectionInput = {};

    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.senderEmail !== undefined) patch.senderEmail = input.senderEmail;
    if (input.senderName !== undefined) patch.senderName = normalizeOptional(input.senderName);
    if (input.replyToEmail !== undefined) patch.replyToEmail = normalizeOptional(input.replyToEmail);

    if (input.disabled === true) {
      patch.status = "disabled";
      patch.lastErrorCode = "operator_disabled";
    } else if (input.disabled === false) {
      const oauth = await this.options.oauthConnections.get(workspaceId, existing.oauthConnectionId);
      patch.status = this.statusForOauth(oauth);
      patch.lastErrorCode = patch.status === "needs_reauth" ? "oauth_needs_reauth" : null;
    }

    const updated = await this.options.repository.update(workspaceId, connectionId, patch);
    if (!updated) {
      throw notFound("Customer email connection not found");
    }
    return toSummary(updated);
  }

  async checkHealth(workspaceId: string, connectionId: string): Promise<CustomerEmailConnectionSummary> {
    const existing = await this.requireConnection(workspaceId, connectionId);
    const oauth = await this.options.oauthConnections.get(workspaceId, existing.oauthConnectionId);
    const oauthStatus = this.statusForOauth(oauth);
    if (oauthStatus === "needs_reauth") {
      return this.updateHealth(workspaceId, connectionId, {
        status: "needs_reauth",
        lastHealthStatus: "failed",
        lastHealthCheckedAt: new Date(),
        lastErrorCode: "oauth_needs_reauth",
      });
    }
    if (existing.status === "disabled") {
      return this.updateHealth(workspaceId, connectionId, {
        status: "disabled",
        lastHealthStatus: "failed",
        lastHealthCheckedAt: new Date(),
        lastErrorCode: "operator_disabled",
      });
    }

    const provider = this.requireProvider(existing.provider);
    const result = await provider.checkHealth({
      workspaceId,
      connectionId,
      oauthConnectionId: existing.oauthConnectionId,
      senderEmail: existing.senderEmail,
    });
    return this.updateHealth(workspaceId, connectionId, {
      status: result.status === "ok" ? "authorized" : "error",
      lastHealthStatus: result.status,
      lastHealthCheckedAt: new Date(),
      lastErrorCode: result.status === "ok" ? null : result.errorCode ?? "provider_health_failed",
    });
  }

  async remove(workspaceId: string, connectionId: string): Promise<void> {
    await this.requireConnection(workspaceId, connectionId);
    const references = await this.options.repository.countSkillReferences(workspaceId, connectionId);
    if (references > 0) {
      throw conflict("Customer email connection is still referenced by an email skill");
    }
    const removed = await this.options.repository.remove(workspaceId, connectionId);
    if (!removed) {
      throw notFound("Customer email connection not found");
    }
  }

  private async requireUsableOauthConnection(
    workspaceId: string,
    oauthConnectionId: string,
  ): Promise<OauthConnectionSummary> {
    const oauth = await this.options.oauthConnections.get(workspaceId, oauthConnectionId);
    if (!customerEmailProviderSet.has(oauth.provider)) {
      throw badRequest("OAuth connection provider is not supported for customer email");
    }
    if (oauth.status !== "authorized") {
      throw badRequest("OAuth connection must be authorized before creating customer email");
    }
    assertCustomerEmailScopes(oauth.provider as CustomerEmailOauthProviderId, oauth.grantedScopes, ["draft", "send"]);
    this.requireProvider(oauth.provider);
    return oauth;
  }

  private requireProvider(providerId: string) {
    const provider = this.options.providers.get(providerId);
    if (!provider) {
      throw badRequest("Customer email provider is not configured");
    }
    return provider;
  }

  private statusForOauth(oauth: OauthConnectionSummary): CustomerEmailConnectionStatus {
    return oauth.status === "authorized" ? "authorized" : "needs_reauth";
  }

  private async requireConnection(workspaceId: string, connectionId: string): Promise<CustomerEmailConnectionRecord> {
    const record = await this.options.repository.findById(workspaceId, connectionId);
    if (!record) {
      throw notFound("Customer email connection not found");
    }
    return record;
  }

  private async updateHealth(
    workspaceId: string,
    connectionId: string,
    input: Required<Pick<
      UpdateCustomerEmailConnectionInput,
      "status" | "lastHealthStatus" | "lastHealthCheckedAt" | "lastErrorCode"
    >>,
  ): Promise<CustomerEmailConnectionSummary> {
    const updated = await this.options.repository.update(workspaceId, connectionId, input);
    if (!updated) {
      throw notFound("Customer email connection not found");
    }
    return toSummary(updated);
  }
}
