import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { createClient } from "redis";

import { isExpired } from "../auth/token.js";
import type { AccessSessionRecord, SessionStore } from "../auth/sessionStore.js";
import { hashToken } from "../auth/token.js";

interface RuntimeRedisStoreOptions {
  keyPrefix: string;
  redisUrl: string;
  signingSecret: string;
}

const ttlSecondsFromDate = (expiresAt: Date, now = new Date()): number =>
  Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

const sessionIdKey = (prefix: string, sessionId: string) => `${prefix}:session:id:${sessionId}`;
const sessionTokenKey = (prefix: string, tokenHash: string) => `${prefix}:session:token:${tokenHash}`;

const cloneSession = (session: AccessSessionRecord): AccessSessionRecord => ({
  ...session,
  approvalRequiredTools: session.approvalRequiredTools ? [...session.approvalRequiredTools] : undefined,
  expiresAt: new Date(session.expiresAt),
  grantedProfiles: session.grantedProfiles ? [...session.grantedProfiles] : undefined,
  grantedTools: [...session.grantedTools],
  issuedAt: new Date(session.issuedAt),
  converseSessionToken: session.converseSessionToken,
  upstreamSupportedTools: session.upstreamSupportedTools ? [...session.upstreamSupportedTools] : undefined,
});

const deriveSessionEncryptionKey = (signingSecret: string): Buffer =>
  createHash("sha256").update(`radioso-mcp-session:${signingSecret}`).digest();

const encryptSessionSecret = (value: string, signingSecret: string): {
  authTag: string;
  ciphertext: string;
  iv: string;
} => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveSessionEncryptionKey(signingSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
  };
};

const decryptSessionSecret = (payload: {
  authTag: string;
  ciphertext: string;
  iv: string;
}, signingSecret: string): string => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveSessionEncryptionKey(signingSecret),
    Buffer.from(payload.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export const serializeSession = (session: AccessSessionRecord, signingSecret: string): string =>
  JSON.stringify({
    ...session,
    expiresAt: session.expiresAt.toISOString(),
    issuedAt: session.issuedAt.toISOString(),
    upstreamApiToken: undefined,
    upstreamApiTokenEncrypted: session.upstreamApiToken
      ? encryptSessionSecret(session.upstreamApiToken, signingSecret)
      : undefined,
    // converseSessionToken is a bearer for /api/v1/mcp/converse/* — treat it as secret
    // material like the upstream API token, never store it plaintext in Redis.
    converseSessionToken: undefined,
    converseSessionTokenEncrypted: session.converseSessionToken
      ? encryptSessionSecret(session.converseSessionToken, signingSecret)
      : undefined,
  });

export const deserializeSession = (value: string, signingSecret: string): AccessSessionRecord => {
  const parsed = JSON.parse(value) as Omit<AccessSessionRecord, "expiresAt" | "issuedAt"> & {
    expiresAt: string;
    issuedAt: string;
    upstreamApiToken?: string;
    upstreamApiTokenEncrypted?: {
      authTag: string;
      ciphertext: string;
      iv: string;
    };
    converseSessionToken?: string;
    converseSessionTokenEncrypted?: {
      authTag: string;
      ciphertext: string;
      iv: string;
    };
  };
  const upstreamApiToken = parsed.upstreamApiTokenEncrypted
    ? decryptSessionSecret(parsed.upstreamApiTokenEncrypted, signingSecret)
    : parsed.upstreamApiToken;
  const converseSessionToken = parsed.converseSessionTokenEncrypted
    ? decryptSessionSecret(parsed.converseSessionTokenEncrypted, signingSecret)
    : parsed.converseSessionToken;

  return {
    ...parsed,
    expiresAt: new Date(parsed.expiresAt),
    issuedAt: new Date(parsed.issuedAt),
    upstreamApiToken,
    converseSessionToken,
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
  signingSecret,
}: RuntimeRedisStoreOptions): Promise<{
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

      const session = deserializeSession(stored, signingSecret);
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

      const session = deserializeSession(stored, signingSecret);
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

      return cloneSession(deserializeSession(stored, signingSecret));
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
        converseSessionToken: input.converseSessionToken,
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
      const previousStored = await client.get(sessionIdKey(keyPrefix, session.sessionId));
      const transaction = client.multi();

      if (previousStored) {
        const previousSession = deserializeSession(previousStored, signingSecret);
        transaction.del(sessionTokenKey(keyPrefix, previousSession.accessTokenHash));
      }

      await transaction
        .set(sessionIdKey(keyPrefix, session.sessionId), serializeSession(session, signingSecret), { EX: ttlSeconds })
        .set(sessionTokenKey(keyPrefix, session.accessTokenHash), session.sessionId, { EX: ttlSeconds })
        .exec();

      return cloneSession(session);
    },
  };

  return {
    async close() {
      if (client.isOpen) {
        await client.quit();
      }
    },
    sessionStore,
  };
};
