import { randomUUID } from "node:crypto";

import type { AccessGrantRepositoryPort } from "../../../db/repositories/accessGrantRepository.js";
import { badRequest, conflict, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  sha256,
  tokenPrefix,
} from "../../auth/contracts/index.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type {
  AccessGrant,
  AccessGrantChannel,
  AccessGrantEvaluation,
  AccessGrantRole,
  AccessGrantSecret,
  AccessGrantUsageObserver,
  GrantPrincipalKind,
  OriginConstraint,
} from "../domain.js";
import { normalizeAccessGrantLabel } from "../domain.js";
import type { OriginMatcher } from "../originMatcher.js";

interface AccessGrantServiceDependencies {
  repository: AccessGrantRepositoryPort;
  originMatcher: OriginMatcher;
  workspaceTokenSecret?: string;
  auditService?: Pick<AuditService, "record">;
  usageObserver?: AccessGrantUsageObserver;
}

export type AccessGrantLifecycleActor = {
  kind: "user" | "service";
  id: string;
};

export interface AccessGrantIssueInput {
  agentId: string;
  workspaceId: string;
  accountId?: string | null;
  actor?: AccessGrantLifecycleActor | null;
  label?: string | null;
  principalKind: GrantPrincipalKind;
  role?: AccessGrantRole;
  channel?: AccessGrantChannel;
  originConstraint: OriginConstraint;
  expiresAt?: Date | null;
}

export interface PublicLaunchMigrationInput {
  agentId: string;
  workspaceId: string;
  label?: string | null;
  token: string;
  originConstraint: OriginConstraint;
  channel?: AccessGrantChannel;
}

export class AccessGrantService {
  constructor(private readonly dependencies: AccessGrantServiceDependencies) {}

  async issueGrant(input: AccessGrantIssueInput): Promise<AccessGrantSecret> {
    if (input.principalKind === "agent-api") {
      if (input.channel !== "mcp-converse" && input.channel !== "agent-api") {
        throw badRequest("Agent channel credentials require an MCP or REST audience.");
      }
      if (!input.expiresAt || input.expiresAt.getTime() <= Date.now()) {
        throw badRequest("Agent channel credentials require a future expiry.");
      }
    }
    const token = generateApiToken();
    const grant = await this.dependencies.repository.save({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      label: input.label == null ? null : this.normalizeLabel(input.label),
      principalKind: input.principalKind,
      role: input.role ?? this.defaultRole(input.principalKind, input.channel),
      channel: input.channel ?? this.defaultChannel(input.principalKind),
      tokenPrefix: tokenPrefix(token),
      tokenHash: sha256(token),
      encryptedToken: input.principalKind === "agent-api"
        ? null
        : encryptSecret(token, this.workspaceTokenSecret()),
      originConstraint: input.originConstraint,
      expiresAt: input.expiresAt ?? null,
    });
    await this.recordLifecycleEvent("access_grant.issue", "success", {
      accountId: input.accountId,
      actor: input.actor,
      workspaceId: input.workspaceId,
      grant,
    });
    return { grant, token };
  }

  async migratePublicLaunchToken(input: PublicLaunchMigrationInput): Promise<AccessGrant> {
    const grant = await this.dependencies.repository.save({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      label: input.label == null ? null : this.normalizeLabel(input.label),
      principalKind: "public-launch",
      role: "public",
      channel: input.channel ?? "public-link",
      tokenPrefix: tokenPrefix(input.token),
      tokenHash: sha256(input.token),
      encryptedToken: encryptSecret(input.token, this.workspaceTokenSecret()),
      originConstraint: input.originConstraint,
    });
    return grant;
  }

  async rotateGrant(input: {
    grantId: string;
    accountId?: string | null;
    actor?: AccessGrantLifecycleActor | null;
    reason?: string | null;
  }): Promise<AccessGrantSecret> {
    const current = await this.dependencies.repository.findById(input.grantId);
    if (!current) {
      throw notFound("Access grant not found");
    }
    const now = new Date();
    const requireActiveAgentChannel = current.principalKind === "agent-api";
    if (requireActiveAgentChannel && !this.isActiveAt(current, now)) {
      throw badRequest("Only active agent channel credentials can be rotated");
    }
    const token = generateApiToken();
    const grant = await this.dependencies.repository.rotate(input.grantId, {
      tokenPrefix: tokenPrefix(token),
      tokenHash: sha256(token),
      encryptedToken: current.principalKind === "agent-api"
        ? null
        : encryptSecret(token, this.workspaceTokenSecret()),
      expectedTokenHash: requireActiveAgentChannel ? current.tokenHash : undefined,
      requireActiveAgentChannel,
      now,
    });
    if (!grant) {
      if (requireActiveAgentChannel) {
        const latest = await this.dependencies.repository.findById(input.grantId);
        if (latest && !this.isActiveAt(latest, now)) {
          throw badRequest("Only active agent channel credentials can be rotated");
        }
        if (latest) {
          throw conflict("Access grant was changed concurrently");
        }
      }
      throw notFound("Access grant not found");
    }
    await this.recordLifecycleEvent("access_grant.rotate", "success", {
      accountId: input.accountId,
      actor: input.actor,
      workspaceId: grant.workspaceId,
      grant,
      reason: input.reason,
    });
    return { grant, token };
  }

  async revokeGrant(input: {
    grantId: string;
    accountId?: string | null;
    actor?: AccessGrantLifecycleActor | null;
    reason?: string | null;
  }): Promise<AccessGrant> {
    const grant = await this.dependencies.repository.revoke(input.grantId, new Date());
    if (!grant) {
      throw notFound("Access grant not found");
    }
    await this.recordLifecycleEvent("access_grant.revoke", "success", {
      accountId: input.accountId,
      actor: input.actor,
      workspaceId: grant.workspaceId,
      grant,
      reason: input.reason,
    });
    return grant;
  }

  async updateGrantConstraints(input: {
    grantId: string;
    originConstraint?: OriginConstraint;
    enabled?: boolean;
    label?: string | null;
  }): Promise<AccessGrant> {
    const grant = await this.dependencies.repository.updateConstraints(input.grantId, {
      originConstraint: input.originConstraint,
      enabled: input.enabled,
      label: input.label === undefined || input.label === null
        ? input.label
        : this.normalizeLabel(input.label),
    });
    if (!grant) {
      throw notFound("Access grant not found");
    }
    return grant;
  }

  async touchGrant(grantId: string, lastUsedAt = new Date()): Promise<void> {
    try {
      void this.dependencies.repository.touch(grantId, lastUsedAt).catch(() => this.recordLastUsePersistenceFailure());
    } catch {
      this.recordLastUsePersistenceFailure();
    }
  }

  async resolvePublicLaunchGrant(token: string): Promise<AccessGrant | null> {
    const grant = await this.dependencies.repository.findByTokenHash(sha256(token));
    if (!grant || grant.principalKind !== "public-launch" || grant.channel === "mcp-converse") {
      return null;
    }
    return grant;
  }

  async findGrantById(grantId: string): Promise<AccessGrant | null> {
    return this.dependencies.repository.findById(grantId);
  }

  async listAgentGrants(agentId: string, params: {
    workspaceId?: string;
    principalKind?: GrantPrincipalKind;
    channel?: AccessGrantChannel;
    limit?: number;
    cursor?: { createdAt: Date; id: string };
  } = {}): Promise<{ grants: AccessGrant[]; nextCursor: { createdAt: Date; id: string } | null }> {
    return this.dependencies.repository.listByAgent(agentId, params);
  }

  async resolveConverseGrant(token: string): Promise<AccessGrant | null> {
    return this.resolveAgentChannelGrant(token, "mcp-converse");
  }

  async resolveAgentChannelGrant(
    token: string,
    channel: Extract<AccessGrantChannel, "mcp-converse" | "agent-api">,
  ): Promise<AccessGrant | null> {
    const grant = await this.dependencies.repository.findByTokenHash(sha256(token));
    if (
      !grant ||
      grant.principalKind !== "agent-api" ||
      grant.channel !== channel
    ) {
      return null;
    }
    return grant;
  }

  async resolveOrCreatePublicLaunchGrant(input: PublicLaunchMigrationInput): Promise<AccessGrant> {
    const existing = await this.resolvePublicLaunchGrant(input.token);
    if (existing) {
      return existing;
    }
    return this.migratePublicLaunchToken(input);
  }

  evaluate(grant: AccessGrant, input: {
    origin?: string | null;
    now?: Date;
  }): AccessGrantEvaluation {
    if (grant.revokedAt) {
      return { allowed: false, reason: "revoked" };
    }
    if (!grant.enabled) {
      return { allowed: false, reason: "disabled" };
    }
    if (grant.expiresAt && grant.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) {
      return { allowed: false, reason: "expired" };
    }
    // A null/undefined origin means "no Origin to enforce" (a same-origin request;
    // the embed widget omits Origin when same-origin to the proxy — #609→#612) and
    // is allowed for the origin dimension. Callers that require an Origin reject its
    // absence upstream. Only a *present* origin is matched against the constraint.
    if (
      grant.originConstraint.mode !== "allow-all" &&
      input.origin != null &&
      !this.dependencies.originMatcher.matches(grant.originConstraint, input.origin)
    ) {
      return { allowed: false, reason: "origin_denied" };
    }
    return { allowed: true };
  }

  revealToken(grant: AccessGrant): string {
    if (!grant.encryptedToken) {
      throw notFound("Access grant secret is not recoverable");
    }
    return decryptSecret(grant.encryptedToken, this.workspaceTokenSecret());
  }

  async recordAuthFailure(input: {
    grant?: Pick<AccessGrant, "id" | "workspaceId" | "agentId" | "principalKind"> | null;
    workspaceId?: string | null;
    reason: string;
    surface: "anonymous-chat" | "website-embed" | "public-session" | "bearer" | "mcp-converse" | "agent-api";
  }): Promise<void> {
    await this.dependencies.auditService?.record({
      workspaceId: input.grant?.workspaceId ?? input.workspaceId ?? undefined,
      eventType: "access_grant.auth",
      eventStatus: "failure",
      metadata: {
        reason: input.reason,
        surface: input.surface,
        grantId: input.grant?.id ?? null,
        agentId: input.grant?.agentId ?? null,
        principalKind: input.grant?.principalKind ?? null,
      },
    });
  }

  async recordAgentChannelChatSucceeded(input: {
    grant: Pick<AccessGrant, "id" | "workspaceId" | "agentId" | "principalKind" | "channel" | "role">;
  }): Promise<void> {
    await this.dependencies.auditService?.record({
      workspaceId: input.grant.workspaceId,
      eventType: "agent_api.chat",
      eventStatus: "success",
      metadata: {
        grantId: input.grant.id,
        agentId: input.grant.agentId,
        workspaceId: input.grant.workspaceId,
        audience: accessGrantAudience(input.grant.channel),
        principalKind: input.grant.principalKind,
        role: input.grant.role,
      },
    });
  }

  private normalizeLabel(value: string): string {
    return normalizeAccessGrantLabel(value);
  }

  private recordLastUsePersistenceFailure(): void {
    try {
      this.dependencies.usageObserver?.recordLastUsePersistenceFailure?.();
    } catch {
      // Authentication and channel traffic must not depend on observability.
    }
  }

  private isActiveAt(grant: AccessGrant, now: Date): boolean {
    return !grant.revokedAt && (!grant.expiresAt || grant.expiresAt.getTime() > now.getTime());
  }

  private workspaceTokenSecret(): string {
    if (!this.dependencies.workspaceTokenSecret) {
      throw serviceUnavailable("Access grants are not configured.", {
        missingEnv: "WORKSPACE_TOKEN_SECRET",
      });
    }
    return this.dependencies.workspaceTokenSecret;
  }

  private defaultRole(kind: GrantPrincipalKind, channel?: AccessGrantChannel): AccessGrantRole {
    if (kind === "agent-api") {
      return "agent";
    }
    if (kind === "public-launch") {
      return "public";
    }
    throw serviceUnavailable(`No default role is configured for ${kind} access grants.`);
  }

  private defaultChannel(kind: GrantPrincipalKind): AccessGrantChannel {
    if (kind === "public-launch") {
      return "public-link";
    }
    if (kind === "agent-api") {
      return "agent-api";
    }
    return "embed";
  }

  private async recordLifecycleEvent(
    eventType: "access_grant.issue" | "access_grant.rotate" | "access_grant.revoke",
    eventStatus: "success",
    input: {
      accountId?: string | null;
      actor?: AccessGrantLifecycleActor | null;
      workspaceId: string;
      grant: AccessGrant;
      reason?: string | null;
    },
  ): Promise<void> {
    await this.dependencies.auditService?.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus,
      metadata: {
        grantId: input.grant.id,
        agentId: input.grant.agentId,
        principalKind: input.grant.principalKind,
        actor: input.actor ?? null,
        audience: accessGrantAudience(input.grant.channel),
        label: input.grant.label,
        reason: input.reason ?? null,
        auditCorrelationId: randomUUID(),
      },
    });
  }
}

const accessGrantAudience = (channel: AccessGrantChannel): "mcp" | "rest" | "public-link" | "embed" => {
  if (channel === "mcp-converse") return "mcp";
  if (channel === "agent-api") return "rest";
  return channel;
};
