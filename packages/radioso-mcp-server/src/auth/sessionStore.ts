import { hashToken, isExpired } from "./token.js";

export interface AccessSessionRecord {
  accessTokenHash: string;
  clientName?: string;
  expiresAt: Date;
  issuedAt: Date;
  converseSessionToken?: string;
  sessionId: string;
}

export interface SessionStore {
  delete(sessionId: string): Promise<boolean>;
  getByAccessToken(accessToken: string, now?: Date): Promise<AccessSessionRecord | null>;
  getById(sessionId: string): Promise<AccessSessionRecord | null>;
  save(input: {
    accessToken: string;
    clientName?: string;
    expiresAt: Date;
    issuedAt: Date;
    converseSessionToken?: string;
    sessionId: string;
  }): Promise<AccessSessionRecord>;
}

const cloneSession = (session: AccessSessionRecord): AccessSessionRecord => ({
  ...session,
  expiresAt: new Date(session.expiresAt),
  issuedAt: new Date(session.issuedAt),
  converseSessionToken: session.converseSessionToken,
});

export const createInMemorySessionStore = (): SessionStore => {
  const sessionsById = new Map<string, AccessSessionRecord>();
  const sessionIdsByAccessTokenHash = new Map<string, string>();

  return {
    async delete(sessionId) {
      const session = sessionsById.get(sessionId);
      if (!session) {
        return false;
      }

      sessionsById.delete(sessionId);
      sessionIdsByAccessTokenHash.delete(session.accessTokenHash);
      return true;
    },
    async getByAccessToken(accessToken, now = new Date()) {
      const sessionId = sessionIdsByAccessTokenHash.get(hashToken(accessToken));
      if (!sessionId) {
        return null;
      }

      const session = sessionsById.get(sessionId);
      if (!session) {
        return null;
      }

      if (isExpired(session.expiresAt, now)) {
        sessionsById.delete(sessionId);
        sessionIdsByAccessTokenHash.delete(session.accessTokenHash);
        return null;
      }

      return cloneSession(session);
    },
    async getById(sessionId) {
      const session = sessionsById.get(sessionId);
      return session ? cloneSession(session) : null;
    },
    async save(input) {
      const session: AccessSessionRecord = {
        accessTokenHash: hashToken(input.accessToken),
        clientName: input.clientName,
        expiresAt: new Date(input.expiresAt),
        issuedAt: new Date(input.issuedAt),
        converseSessionToken: input.converseSessionToken,
        sessionId: input.sessionId,
      };

      const previousSession = sessionsById.get(session.sessionId);
      if (previousSession) {
        sessionIdsByAccessTokenHash.delete(previousSession.accessTokenHash);
      }

      sessionsById.set(session.sessionId, session);
      sessionIdsByAccessTokenHash.set(session.accessTokenHash, session.sessionId);

      return cloneSession(session);
    },
  };
};
