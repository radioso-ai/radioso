import { hashToken, isExpired } from "./token.js";

export interface ApprovalGrantRecord {
  approvalId: string;
  approvalTokenHash: string;
  allowedTools: string[];
  expiresAt: Date;
  issuedAt: Date;
  reason: string;
  remainingUses?: number;
  resourceHints?: string[];
  sessionId: string;
}

export type ApprovalConsumeResult =
  | { grant: ApprovalGrantRecord; status: "consumed" }
  | { status: "missing" }
  | { grant: ApprovalGrantRecord; status: "session_mismatch" }
  | { grant: ApprovalGrantRecord; status: "tool_forbidden" };

export interface ApprovalStore {
  consumeByToken(approvalToken: string, now?: Date): Promise<ApprovalGrantRecord | null>;
  consumeForSessionTool(
    approvalToken: string,
    input: { sessionId: string; toolName: string },
    now?: Date,
  ): Promise<ApprovalConsumeResult>;
  getByToken(approvalToken: string, now?: Date): Promise<ApprovalGrantRecord | null>;
  listBySessionId(sessionId: string, now?: Date): Promise<ApprovalGrantRecord[]>;
  save(input: {
    approvalToken: string;
    allowedTools: string[];
    approvalId: string;
    expiresAt: Date;
    issuedAt: Date;
    reason: string;
    remainingUses?: number;
    resourceHints?: string[];
    sessionId: string;
  }): Promise<ApprovalGrantRecord>;
}

const cloneGrant = (grant: ApprovalGrantRecord): ApprovalGrantRecord => ({
  ...grant,
  allowedTools: [...grant.allowedTools],
  expiresAt: new Date(grant.expiresAt),
  issuedAt: new Date(grant.issuedAt),
  resourceHints: grant.resourceHints ? [...grant.resourceHints] : undefined,
});

export const createInMemoryApprovalStore = (): ApprovalStore => {
  const grantsById = new Map<string, ApprovalGrantRecord>();
  const grantIdsByTokenHash = new Map<string, string>();

  const getGrantByTokenHash = (tokenHash: string, now = new Date()): ApprovalGrantRecord | null => {
    const grantId = grantIdsByTokenHash.get(tokenHash);
    if (!grantId) {
      return null;
    }

    const grant = grantsById.get(grantId);
    if (!grant) {
      return null;
    }

    if (isExpired(grant.expiresAt, now)) {
      grantsById.delete(grantId);
      grantIdsByTokenHash.delete(tokenHash);
      return null;
    }

    if (grant.remainingUses === 0) {
      return null;
    }

    return cloneGrant(grant);
  };

  return {
    async consumeByToken(approvalToken, now = new Date()) {
      const tokenHash = hashToken(approvalToken);
      const grant = getGrantByTokenHash(tokenHash, now);
      if (!grant) {
        return null;
      }

      const storedGrant = grantsById.get(grant.approvalId);
      if (!storedGrant) {
        return null;
      }

      const remainingAllowedTools = storedGrant.allowedTools.slice(1);
      const remainingUses =
        typeof storedGrant.remainingUses === "number"
          ? Math.max(0, storedGrant.remainingUses - 1)
          : remainingAllowedTools.length;

      if (remainingUses === 0 || remainingAllowedTools.length === 0) {
        grantsById.delete(storedGrant.approvalId);
        grantIdsByTokenHash.delete(tokenHash);
        return {
          ...grant,
          allowedTools: remainingAllowedTools,
          remainingUses: 0,
        };
      }

      storedGrant.allowedTools = remainingAllowedTools;
      storedGrant.remainingUses = remainingUses;
      grantsById.set(storedGrant.approvalId, storedGrant);

      return cloneGrant(storedGrant);
    },
    async consumeForSessionTool(approvalToken, input, now = new Date()) {
      const grant = getGrantByTokenHash(hashToken(approvalToken), now);
      if (!grant) {
        return { status: "missing" };
      }

      if (grant.sessionId !== input.sessionId) {
        return {
          grant,
          status: "session_mismatch",
        };
      }

      if (!grant.allowedTools.includes(input.toolName)) {
        return {
          grant,
          status: "tool_forbidden",
        };
      }

      const storedGrant = grantsById.get(grant.approvalId);
      if (!storedGrant) {
        return { status: "missing" };
      }

      const remainingAllowedTools = storedGrant.allowedTools.filter((toolName) => toolName !== input.toolName);
      const remainingUses =
        typeof storedGrant.remainingUses === "number"
          ? Math.max(0, storedGrant.remainingUses - 1)
          : remainingAllowedTools.length;

      if (remainingUses === 0 || remainingAllowedTools.length === 0) {
        grantsById.delete(storedGrant.approvalId);
        grantIdsByTokenHash.delete(storedGrant.approvalTokenHash);
        return {
          grant: {
            ...grant,
            allowedTools: remainingAllowedTools,
            remainingUses: 0,
          },
          status: "consumed",
        };
      }

      storedGrant.allowedTools = remainingAllowedTools;
      storedGrant.remainingUses = remainingUses;
      grantsById.set(storedGrant.approvalId, storedGrant);
      return {
        grant: cloneGrant(storedGrant),
        status: "consumed",
      };
    },
    async getByToken(approvalToken, now = new Date()) {
      return getGrantByTokenHash(hashToken(approvalToken), now);
    },
    async listBySessionId(sessionId, now = new Date()) {
      return [...grantsById.values()]
        .filter((grant) => grant.sessionId === sessionId)
        .filter((grant) => !isExpired(grant.expiresAt, now))
        .filter((grant) => grant.remainingUses !== 0)
        .map(cloneGrant);
    },
    async save(input) {
      const grant: ApprovalGrantRecord = {
        allowedTools: [...input.allowedTools],
        approvalId: input.approvalId,
        approvalTokenHash: hashToken(input.approvalToken),
        expiresAt: new Date(input.expiresAt),
        issuedAt: new Date(input.issuedAt),
        reason: input.reason,
        remainingUses: input.remainingUses,
        resourceHints: input.resourceHints ? [...input.resourceHints] : undefined,
        sessionId: input.sessionId,
      };

      grantsById.set(grant.approvalId, grant);
      grantIdsByTokenHash.set(grant.approvalTokenHash, grant.approvalId);

      return cloneGrant(grant);
    },
  };
};
