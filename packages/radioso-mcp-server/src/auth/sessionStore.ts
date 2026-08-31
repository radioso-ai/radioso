import { hashToken, isExpired } from "./token.js";

export interface AccessSessionRecord {
  accessTokenHash: string;
  approvalRequiredTools?: string[];
  clientName?: string;
  expiresAt: Date;
  grantedProfiles?: string[];
  grantedTools: string[];
  issuedAt: Date;
  converseSessionToken?: string;
  sessionId: string;
  upstreamApiVersion?: string;
  upstreamMcpContextVersion?: string;
  upstreamSupportedTools?: string[];
  upstreamApiToken?: string;
  workspaceId?: string;
  workspaceHint?: string;
  workspaceName?: string;
}

export interface LegacySessionPurger {
  purgeLegacyApiTokenSessions(): Promise<{ purgedSessionCount: number }>;
}

export interface SessionStore extends LegacySessionPurger {
  delete(sessionId: string): Promise<boolean>;
  getByAccessToken(accessToken: string, now?: Date): Promise<AccessSessionRecord | null>;
  getById(sessionId: string): Promise<AccessSessionRecord | null>;
  save(input: {
    accessToken: string;
    approvalRequiredTools?: string[];
    clientName?: string;
    expiresAt: Date;
    grantedProfiles?: string[];
    grantedTools: string[];
    issuedAt: Date;
    converseSessionToken?: string;
    sessionId: string;
    upstreamApiVersion?: string;
    upstreamMcpContextVersion?: string;
    upstreamSupportedTools?: string[];
    upstreamApiToken?: string;
    workspaceId?: string;
    workspaceHint?: string;
    workspaceName?: string;
  }): Promise<AccessSessionRecord>;
}

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
    async purgeLegacyApiTokenSessions() {
      let purgedSessionCount = 0;
      for (const [sessionId, session] of sessionsById) {
        if (session.upstreamApiToken === undefined) {
          continue;
        }
        sessionsById.delete(sessionId);
        sessionIdsByAccessTokenHash.delete(session.accessTokenHash);
        purgedSessionCount += 1;
      }
      return { purgedSessionCount };
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
        workspaceId: input.workspaceId,
        workspaceHint: input.workspaceHint,
        workspaceName: input.workspaceName,
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
