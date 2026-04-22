import { createClient } from "redis";

import { isExpired } from "../auth/token.js";
import type { ApprovalConsumeResult, ApprovalGrantRecord, ApprovalStore } from "../auth/approvalStore.js";
import type { AccessSessionRecord, SessionStore } from "../auth/sessionStore.js";
import { hashToken } from "../auth/token.js";

interface RuntimeRedisStoreOptions {
  keyPrefix: string;
  redisUrl: string;
}

const ttlSecondsFromDate = (expiresAt: Date, now = new Date()): number =>
  Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

const sessionIdKey = (prefix: string, sessionId: string) => `${prefix}:session:id:${sessionId}`;
const sessionTokenKey = (prefix: string, tokenHash: string) => `${prefix}:session:token:${tokenHash}`;
const approvalIdKey = (prefix: string, approvalId: string) => `${prefix}:approval:id:${approvalId}`;
const approvalTokenKey = (prefix: string, tokenHash: string) => `${prefix}:approval:token:${tokenHash}`;

const cloneSession = (session: AccessSessionRecord): AccessSessionRecord => ({
  ...session,
  approvalRequiredTools: session.approvalRequiredTools ? [...session.approvalRequiredTools] : undefined,
  expiresAt: new Date(session.expiresAt),
  grantedProfiles: session.grantedProfiles ? [...session.grantedProfiles] : undefined,
  grantedTools: [...session.grantedTools],
  issuedAt: new Date(session.issuedAt),
  upstreamSupportedTools: session.upstreamSupportedTools ? [...session.upstreamSupportedTools] : undefined,
});

const cloneApproval = (grant: ApprovalGrantRecord): ApprovalGrantRecord => ({
  ...grant,
  allowedTools: [...grant.allowedTools],
  expiresAt: new Date(grant.expiresAt),
  issuedAt: new Date(grant.issuedAt),
  resourceHints: grant.resourceHints ? [...grant.resourceHints] : undefined,
});

const serializeSession = (session: AccessSessionRecord): string =>
  JSON.stringify({
    ...session,
    expiresAt: session.expiresAt.toISOString(),
    issuedAt: session.issuedAt.toISOString(),
  });

const deserializeSession = (value: string): AccessSessionRecord => {
  const parsed = JSON.parse(value) as Omit<AccessSessionRecord, "expiresAt" | "issuedAt"> & {
    expiresAt: string;
    issuedAt: string;
  };

  return {
    ...parsed,
    expiresAt: new Date(parsed.expiresAt),
    issuedAt: new Date(parsed.issuedAt),
  };
};

const serializeApproval = (grant: ApprovalGrantRecord): string =>
  JSON.stringify({
    ...grant,
    expiresAt: grant.expiresAt.toISOString(),
    issuedAt: grant.issuedAt.toISOString(),
  });

const deserializeApproval = (value: string): ApprovalGrantRecord => {
  const parsed = JSON.parse(value) as Omit<ApprovalGrantRecord, "expiresAt" | "issuedAt"> & {
    expiresAt: string;
    issuedAt: string;
  };

  return {
    ...parsed,
    expiresAt: new Date(parsed.expiresAt),
    issuedAt: new Date(parsed.issuedAt),
  };
};

const ensureConnected = async (client: { connect(): Promise<unknown>; isOpen: boolean }): Promise<void> => {
  if (!client.isOpen) {
    await client.connect();
  }
};

export const createRedisClientHandle = async ({
  keyPrefix,
  redisUrl,
}: RuntimeRedisStoreOptions): Promise<{
  approvalStore: ApprovalStore;
  close(): Promise<void>;
  sessionStore: SessionStore;
}> => {
  const client = createClient({ url: redisUrl });
  await ensureConnected(client);

  const sessionStore: SessionStore = {
    async delete(sessionId) {
      const stored = await client.get(sessionIdKey(keyPrefix, sessionId));
      if (!stored) {
        return false;
      }

      const session = deserializeSession(stored);
      await client.del([
        sessionIdKey(keyPrefix, sessionId),
        sessionTokenKey(keyPrefix, session.accessTokenHash),
      ]);
      return true;
    },
    async getByAccessToken(accessToken, now = new Date()) {
      const accessTokenHash = hashToken(accessToken);
      const sessionId = await client.get(sessionTokenKey(keyPrefix, accessTokenHash));
      if (!sessionId) {
        return null;
      }

      const stored = await client.get(sessionIdKey(keyPrefix, sessionId));
      if (!stored) {
        return null;
      }

      const session = deserializeSession(stored);
      if (isExpired(session.expiresAt, now)) {
        await client.del([
          sessionIdKey(keyPrefix, sessionId),
          sessionTokenKey(keyPrefix, accessTokenHash),
        ]);
        return null;
      }

      return cloneSession(session);
    },
    async getById(sessionId) {
      const stored = await client.get(sessionIdKey(keyPrefix, sessionId));
      if (!stored) {
        return null;
      }

      return cloneSession(deserializeSession(stored));
    },
    async save(input) {
      const session: AccessSessionRecord = {
        accessTokenHash: hashToken(input.accessToken),
        approvalRequiredTools: input.approvalRequiredTools ? [...input.approvalRequiredTools] : undefined,
        clientName: input.clientName,
        expiresAt: new Date(input.expiresAt),
        grantedProfiles: input.grantedProfiles ? [...input.grantedProfiles] : undefined,
        grantedTools: [...input.grantedTools],
        issuedAt: new Date(input.issuedAt),
        sessionId: input.sessionId,
        upstreamApiVersion: input.upstreamApiVersion,
        upstreamMcpContextVersion: input.upstreamMcpContextVersion,
        upstreamSupportedTools: input.upstreamSupportedTools ? [...input.upstreamSupportedTools] : undefined,
        upstreamApiToken: input.upstreamApiToken,
        workspaceHint: input.workspaceHint,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
      };

      const ttlSeconds = ttlSecondsFromDate(session.expiresAt);
      await client.multi()
        .set(sessionIdKey(keyPrefix, session.sessionId), serializeSession(session), { EX: ttlSeconds })
        .set(sessionTokenKey(keyPrefix, session.accessTokenHash), session.sessionId, { EX: ttlSeconds })
        .exec();

      return cloneSession(session);
    },
  };

  const approvalStore: ApprovalStore = {
    async consumeByToken(approvalToken, now = new Date()) {
      const tokenHash = hashToken(approvalToken);
      const tokenKey = approvalTokenKey(keyPrefix, tokenHash);
      const isolatedClient = client.duplicate();
      await ensureConnected(isolatedClient);

      try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await isolatedClient.watch(tokenKey);
          const approvalId = await isolatedClient.get(tokenKey);
          if (!approvalId) {
            await isolatedClient.unwatch();
            return null;
          }

          const idKey = approvalIdKey(keyPrefix, approvalId);
          await isolatedClient.watch(idKey);
          const stored = await isolatedClient.get(idKey);
          if (!stored) {
            await isolatedClient.unwatch();
            return null;
          }

          const grant = deserializeApproval(stored);
          if (isExpired(grant.expiresAt, now) || grant.remainingUses === 0) {
            const expiredResult = await isolatedClient.multi().del([tokenKey, idKey]).exec();
            if (expiredResult !== null) {
              return null;
            }
            continue;
          }

          if (grant.remainingUses === 1) {
            const result = await isolatedClient.multi().del([tokenKey, idKey]).exec();
            if (result === null) {
              continue;
            }

            return {
              ...cloneApproval(grant),
              remainingUses: 0,
            };
          }

          const updatedGrant: ApprovalGrantRecord = {
            ...grant,
            remainingUses: typeof grant.remainingUses === "number" ? grant.remainingUses - 1 : grant.remainingUses,
          };
          const ttlSeconds = ttlSecondsFromDate(updatedGrant.expiresAt, now);
          const result = await isolatedClient.multi()
            .set(idKey, serializeApproval(updatedGrant), { EX: ttlSeconds })
            .exec();

          if (result === null) {
            continue;
          }

          return cloneApproval(updatedGrant);
        }

        return null;
      } finally {
        if (isolatedClient.isOpen) {
          await isolatedClient.quit();
        }
      }
    },
    async consumeForSessionTool(approvalToken, input, now = new Date()): Promise<ApprovalConsumeResult> {
      const grant = await this.getByToken(approvalToken, now);
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

      const consumedGrant = await this.consumeByToken(approvalToken, now);
      return consumedGrant
        ? {
            grant: consumedGrant,
            status: "consumed",
          }
        : {
            status: "missing",
          };
    },
    async getByToken(approvalToken, now = new Date()) {
      const tokenHash = hashToken(approvalToken);
      const approvalId = await client.get(approvalTokenKey(keyPrefix, tokenHash));
      if (!approvalId) {
        return null;
      }

      const stored = await client.get(approvalIdKey(keyPrefix, approvalId));
      if (!stored) {
        return null;
      }

      const grant = deserializeApproval(stored);
      if (isExpired(grant.expiresAt, now) || grant.remainingUses === 0) {
        await client.del([
          approvalTokenKey(keyPrefix, tokenHash),
          approvalIdKey(keyPrefix, approvalId),
        ]);
        return null;
      }

      return cloneApproval(grant);
    },
    async listBySessionId(sessionId, now = new Date()) {
      const grants: ApprovalGrantRecord[] = [];

      for await (const key of client.scanIterator({ MATCH: approvalIdKey(keyPrefix, "*"), COUNT: 100 })) {
        if (typeof key !== "string") {
          continue;
        }

        const stored = await client.get(key);
        if (!stored) {
          continue;
        }

        const grant = deserializeApproval(stored);
        if (grant.sessionId !== sessionId || isExpired(grant.expiresAt, now) || grant.remainingUses === 0) {
          continue;
        }

        grants.push(cloneApproval(grant));
      }

      return grants;
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

      const ttlSeconds = ttlSecondsFromDate(grant.expiresAt);
      await client.multi()
        .set(approvalIdKey(keyPrefix, grant.approvalId), serializeApproval(grant), { EX: ttlSeconds })
        .set(approvalTokenKey(keyPrefix, grant.approvalTokenHash), grant.approvalId, { EX: ttlSeconds })
        .exec();

      return cloneApproval(grant);
    },
  };

  return {
    approvalStore,
    async close() {
      if (client.isOpen) {
        await client.quit();
      }
    },
    sessionStore,
  };
};
