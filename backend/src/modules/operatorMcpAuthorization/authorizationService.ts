import { createHash, randomUUID } from "node:crypto";

import type { OperatorMcpScope } from "@radioso/operator-mcp-contract";
import type { AuditPort } from "../audit/contracts/index.js";

import type {
  OperatorMcpAuthorizationFlowRepositoryPort,
  OperatorMcpAuthorizationTransactionRecord,
  OperatorMcpLifecycleAttribution,
  PersistedOperatorMcpClient,
} from "./contracts.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import {
  generateOpaqueCredential,
  hashOpaqueCredential,
  OperatorMcpProtocolError,
  parseOperatorMcpScopes,
  validateAuthorizationResource,
  validateRedirectUri,
} from "./domain.js";

export type ResolvedOperatorMcpClient = PersistedOperatorMcpClient;

interface AuthorizationConfig {
  resource: string;
  issuer: string;
  credentialEpoch: string;
  authorizationCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshIdleTtlDays: number;
  refreshAbsoluteTtlDays: number;
}

const codeChallengeFor = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const isSubset = <T>(candidate: readonly T[], ceiling: readonly T[]): boolean => {
  const allowed = new Set(ceiling);
  return candidate.every((value) => allowed.has(value));
};

const issueOpaque = (kind: "at" | "rt" | "code"): string =>
  `radioso_omcp_${kind}_v1_${generateOpaqueCredential()}`;

const parseOptionalToolScopes = (scope?: string): OperatorMcpScope[] | undefined => {
  if (scope === undefined) return undefined;
  const parsed = parseOperatorMcpScopes(scope);
  if (parsed.offlineAccess) throw new OperatorMcpProtocolError("invalid_scope", "invalid_scope");
  return parsed.toolScopes;
};

const oauthRedirect = (base: string, values: Record<string, string>): string => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
};

export class OperatorMcpAuthorizationService {
  constructor(
    private readonly repository: OperatorMcpAuthorizationFlowRepositoryPort,
    private readonly config: AuthorizationConfig,
    private readonly audit?: Pick<AuditPort, "record">,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter">,
  ) {}

  private observe(stage: "authorization" | "token_exchange" | "refresh" | "revocation", outcome: "success" | "failure", reason: string): void {
    this.metrics?.incrementCounter("operator_mcp_oauth_total", {
      help: "Operator MCP OAuth lifecycle outcomes.",
      labels: { stage, outcome, reason },
    });
  }

  private async recordLifecycle(input: {
    attribution: OperatorMcpLifecycleAttribution;
    eventType: "token_exchange" | "refresh" | "revocation";
    eventStatus: "success" | "failure";
    outcome: string;
    reason: string;
  }): Promise<void> {
    await this.audit?.record({
      accountId: input.attribution.accountId,
      workspaceId: input.attribution.workspaceId,
      eventType: `operator_mcp.${input.eventType}`,
      eventStatus: input.eventStatus,
      metadata: {
        userId: input.attribution.userId,
        clientId: input.attribution.clientRecordId,
        grantId: input.attribution.grantId,
        callingSurface: "operator_mcp_oauth",
        outcome: input.outcome,
        reason: input.reason,
      },
    }).catch(() => undefined);
  }

  private async recordDecision(input: {
    transaction: OperatorMcpAuthorizationTransactionRecord;
    decision: "approved" | "denied";
    accountId: string;
    workspaceId: string | null;
    userId: string;
  }): Promise<void> {
    await this.audit?.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "operator_mcp.authorization_decision",
      eventStatus: "success",
      metadata: {
        userId: input.userId,
        clientId: input.transaction.clientRecordId,
        grantId: null,
        callingSurface: "operator_mcp_consent",
        outcome: input.decision,
        reason: input.decision,
      },
    }).catch(() => undefined);
    this.observe("authorization", "success", input.decision);
  }

  async startAuthorization(input: {
    client: ResolvedOperatorMcpClient;
    responseType: string;
    redirectUri: string;
    state: string;
    scope: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource: string;
    now: Date;
  }): Promise<{ transactionId: string; consentUrl: string }> {
    if (input.responseType !== "code" || input.codeChallengeMethod !== "S256") {
      throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
    }
    if (!input.state || input.state.length > 2048 || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) {
      throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
    }
    const resource = validateAuthorizationResource(input.resource, this.config.resource);
    const redirectUri = validateRedirectUri({
      applicationType: input.client.applicationType,
      requested: input.redirectUri,
      registered: input.client.redirectUris,
    });
    const requested = parseOperatorMcpScopes(input.scope);
    const transactionId = randomUUID();
    await this.repository.createTransaction({
      id: transactionId,
      clientRecordId: input.client.recordId,
      clientMetadataSnapshotId: input.client.metadataSnapshotId,
      clientMetadataDigest: input.client.metadataDigest,
      redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      resource,
      requestedToolScopes: requested.toolScopes,
      requestedOfflineAccess: requested.offlineAccess,
      expiresAt: new Date(input.now.getTime() + this.config.authorizationCodeTtlSeconds * 1_000),
      createdAt: input.now,
    });
    const consentUrl = new URL("/oauth/operator-mcp/consent", this.config.issuer);
    consentUrl.searchParams.set("transaction", transactionId);
    return { transactionId, consentUrl: consentUrl.toString() };
  }

  async getTransaction(transactionId: string, now: Date): Promise<OperatorMcpAuthorizationTransactionRecord> {
    const transaction = await this.repository.findTransaction(transactionId, now);
    if (!transaction) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
    return transaction;
  }

  async decide(input: {
    transactionId: string;
    decision: "approve" | "deny";
    sessionId: string;
    accountId: string;
    userId: string;
    workspaceId?: string;
    membershipId?: string;
    approvedToolScopes?: readonly OperatorMcpScope[];
    approvedOfflineAccess?: boolean;
    now: Date;
  }): Promise<{ redirectUrl: string }> {
    const transaction = await this.getTransaction(input.transactionId, input.now);
    if (transaction.status !== "pending" || transaction.expiresAt.getTime() <= input.now.getTime()) {
      throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
    }
    if (input.decision === "deny") {
      const decided = await this.repository.decideTransaction({
        transactionId: input.transactionId,
        sessionId: input.sessionId,
        accountId: input.accountId,
        userId: input.userId,
        workspaceId: null,
        membershipId: null,
        approvedToolScopes: null,
        approvedOfflineAccess: null,
        authorizationCodeDigest: null,
        status: "denied",
        now: input.now,
      });
      if (!decided) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
      await this.recordDecision({ transaction, decision: "denied", accountId: input.accountId, workspaceId: null, userId: input.userId });
      return { redirectUrl: oauthRedirect(transaction.redirectUri, { error: "access_denied", state: transaction.state }) };
    }

    const approvedToolScopes = [...(input.approvedToolScopes ?? [])];
    if (!input.workspaceId || !input.membershipId || approvedToolScopes.length === 0
      || !isSubset(approvedToolScopes, transaction.requestedToolScopes)
      || (input.approvedOfflineAccess === true && !transaction.requestedOfflineAccess)) {
      throw new OperatorMcpProtocolError("invalid_scope", "invalid_scope");
    }
    const code = issueOpaque("code");
    const decided = await this.repository.decideTransaction({
      transactionId: input.transactionId,
      sessionId: input.sessionId,
      accountId: input.accountId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      membershipId: input.membershipId,
      approvedToolScopes,
      approvedOfflineAccess: input.approvedOfflineAccess === true,
      authorizationCodeDigest: hashOpaqueCredential(code),
      status: "approved",
      now: input.now,
    });
    if (!decided) throw new OperatorMcpProtocolError("invalid_request", "invalid_request");
    await this.recordDecision({ transaction, decision: "approved", accountId: input.accountId, workspaceId: input.workspaceId, userId: input.userId });
    return { redirectUrl: oauthRedirect(transaction.redirectUri, { code, state: transaction.state }) };
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
    scope?: string;
    now: Date;
  }): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number; refreshToken: string | null; scope: string }> {
    try {
    validateAuthorizationResource(input.resource, this.config.resource);
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)) {
      throw new OperatorMcpProtocolError("invalid_grant", "invalid_grant");
    }
    const requestedToolScopes = parseOptionalToolScopes(input.scope);
    const accessToken = issueOpaque("at");
    const refreshToken = issueOpaque("rt");
    const accessExpiresAt = new Date(input.now.getTime() + this.config.accessTokenTtlSeconds * 1_000);
    const exchanged = await this.repository.exchangeAuthorizationCode({
      authorizationCodeDigest: hashOpaqueCredential(input.code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      codeChallenge: codeChallengeFor(input.codeVerifier),
      requestedToolScopes,
      credentialEpoch: this.config.credentialEpoch,
      accessCredential: { id: randomUUID(), tokenDigest: hashOpaqueCredential(accessToken), expiresAt: accessExpiresAt },
      refreshCredential: {
        lineageId: randomUUID(),
        tokenDigest: hashOpaqueCredential(refreshToken),
        idleExpiresAt: new Date(input.now.getTime() + this.config.refreshIdleTtlDays * 86_400_000),
        absoluteExpiresAt: new Date(input.now.getTime() + this.config.refreshAbsoluteTtlDays * 86_400_000),
      },
      now: input.now,
    });
    if (!exchanged) throw new OperatorMcpProtocolError("invalid_grant", "invalid_grant");
    const response = {
      accessToken,
      tokenType: "Bearer" as const,
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshToken: exchanged.offlineAccess ? refreshToken : null,
      scope: exchanged.toolScopes.join(" "),
    };
    this.observe("token_exchange", "success", "issued");
    if (exchanged.attribution) await this.recordLifecycle({ attribution: exchanged.attribution, eventType: "token_exchange", eventStatus: "success", outcome: "issued", reason: "authorization_code" });
    return response;
    } catch (error) {
      this.observe("token_exchange", "failure", error instanceof OperatorMcpProtocolError ? error.code : "dependency_error");
      throw error;
    }
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    resource: string;
    scope?: string;
    now: Date;
  }): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number; refreshToken: string; scope: string }> {
    let failureReason: string | null = null;
    try {
    validateAuthorizationResource(input.resource, this.config.resource);
    const requestedToolScopes = parseOptionalToolScopes(input.scope);
    const accessToken = issueOpaque("at");
    const refreshToken = issueOpaque("rt");
    const rotated = await this.repository.rotateRefreshCredential({
      tokenDigest: hashOpaqueCredential(input.refreshToken),
      clientId: input.clientId,
      resource: input.resource,
      requestedToolScopes,
      credentialEpoch: this.config.credentialEpoch,
      accessCredential: {
        id: randomUUID(), tokenDigest: hashOpaqueCredential(accessToken),
        expiresAt: new Date(input.now.getTime() + this.config.accessTokenTtlSeconds * 1_000),
      },
      successorTokenDigest: hashOpaqueCredential(refreshToken),
      idleExpiresAt: new Date(input.now.getTime() + this.config.refreshIdleTtlDays * 86_400_000),
      now: input.now,
    });
    if (rotated.status !== "rotated" || !rotated.toolScopes) {
      failureReason = rotated.status === "replay" ? "refresh_replay" : "invalid_grant";
      if (rotated.attribution) await this.recordLifecycle({ attribution: rotated.attribution, eventType: "refresh", eventStatus: "failure", outcome: "denied", reason: rotated.status === "replay" ? "refresh_replay" : "invalid_grant" });
      throw new OperatorMcpProtocolError("invalid_grant", "invalid_grant");
    }
    this.observe("refresh", "success", "rotated");
    if (rotated.attribution) await this.recordLifecycle({ attribution: rotated.attribution, eventType: "refresh", eventStatus: "success", outcome: "rotated", reason: "refresh_token" });
    return { accessToken, tokenType: "Bearer", expiresIn: this.config.accessTokenTtlSeconds, refreshToken, scope: rotated.toolScopes.join(" ") };
    } catch (error) {
      this.observe("refresh", "failure", failureReason ?? (error instanceof OperatorMcpProtocolError ? error.code : "dependency_error"));
      throw error;
    }
  }

  async revoke(token: string, now: Date): Promise<void> {
    try {
      const attribution = await this.repository.revokeCredentialByDigest({ tokenDigest: hashOpaqueCredential(token), now });
      this.observe("revocation", "success", attribution ? "revoked" : "unknown_token");
      if (attribution) await this.recordLifecycle({ attribution, eventType: "revocation", eventStatus: "success", outcome: "revoked", reason: "oauth_revocation" });
    } catch (error) {
      this.observe("revocation", "failure", "dependency_error");
      throw error;
    }
  }
}
