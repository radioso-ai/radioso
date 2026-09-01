import { randomUUID } from "node:crypto";

import type { ConverseApiAdapter } from "../converseApiAdapter.js";
import { RadiosoApiError } from "../converseApiAdapter.js";
import { toMcpRequestAuthInfo, type McpRequestAuthInfo } from "./authInfo.js";
import type { AccessSessionRecord, SessionStore } from "./sessionStore.js";

export class AuthServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthServiceDependencies {
  converseApi: ConverseApiAdapter;
  now?: () => Date;
  sessionStore: SessionStore;
}

export interface AuthService {
  getRequestAuthInfo(accessToken: string): Promise<McpRequestAuthInfo | null>;
  getSession(accessToken: string): Promise<AccessSessionRecord | null>;
  resolveBearerSession(accessToken: string): Promise<AccessSessionRecord | null>;
}

const defaultNow = () => new Date();

const isAuthenticationFailure = (error: unknown): boolean =>
  error instanceof RadiosoApiError && (error.status === 401 || error.status === 403);

export const createAuthService = (dependencies: AuthServiceDependencies): AuthService => {
  const now = dependencies.now ?? defaultNow;

  const validateConverseSession = async (session: AccessSessionRecord): Promise<AccessSessionRecord | null> => {
    if (!session.converseSessionToken) {
      await dependencies.sessionStore.delete(session.sessionId);
      return null;
    }

    try {
      await dependencies.converseApi.validate(session.converseSessionToken);
      return session;
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        throw error;
      }

      await dependencies.sessionStore.delete(session.sessionId);
      return null;
    }
  };

  const resolveAgentChannelCredential = async (accessToken: string): Promise<AccessSessionRecord | null> => {
    try {
      const issuedAt = now();
      const exchange = await dependencies.converseApi.exchange({
        launchToken: accessToken,
        client: { name: "radioso-mcp-server" },
      });
      await dependencies.converseApi.validate(exchange.sessionToken);

      return dependencies.sessionStore.save({
        accessToken,
        clientName: "radioso-mcp-converse",
        converseSessionToken: exchange.sessionToken,
        expiresAt: new Date(exchange.expiresAt),
        issuedAt,
        sessionId: `converse_${randomUUID()}`,
      });
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        return null;
      }

      throw error;
    }
  };

  const getValidatedSession = async (accessToken: string): Promise<AccessSessionRecord | null> => {
    const session = await dependencies.sessionStore.getByAccessToken(accessToken, now());
    return session ? validateConverseSession(session) : null;
  };

  return {
    async getRequestAuthInfo(accessToken) {
      const session = await getValidatedSession(accessToken);
      return session ? toMcpRequestAuthInfo(session) : null;
    },
    getSession: getValidatedSession,
    async resolveBearerSession(accessToken) {
      return (await getValidatedSession(accessToken)) ?? resolveAgentChannelCredential(accessToken);
    },
  };
};
