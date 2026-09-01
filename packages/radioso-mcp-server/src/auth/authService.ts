import { randomUUID } from "node:crypto";

import type { ConverseApiAdapter } from "../converseApiAdapter.js";
import { RadiosoApiError } from "../converseApiAdapter.js";
import { toMcpRequestAuthInfo, type McpRequestAuthInfo } from "./authInfo.js";
import type { AccessSessionRecord, SessionStore } from "./sessionStore.js";
import { hashToken } from "./token.js";

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
  resolveBearerSession(accessToken: string, sourceDigest?: string): Promise<AccessSessionRecord | null>;
  recordSuccessfulUse(session: AccessSessionRecord, sourceDigest?: string): void;
}

const defaultNow = () => new Date();
const SUCCESSFUL_USE_REFRESH_MS = 5 * 60_000;

const isAuthenticationFailure = (error: unknown): boolean =>
  error instanceof RadiosoApiError && (error.status === 401 || error.status === 403);

export const createAuthService = (dependencies: AuthServiceDependencies): AuthService => {
  const now = dependencies.now ?? defaultNow;
  const pendingBearerResolutions = new Map<string, Promise<AccessSessionRecord | null>>();
  const pendingUseNotifications = new Set<string>();
  const lastSuccessfulUseNotifications = new Map<string, number>();

  const validateConverseSession = async (
    session: AccessSessionRecord,
    sourceDigest?: string,
  ): Promise<AccessSessionRecord | null> => {
    if (!session.converseSessionToken) {
      await dependencies.sessionStore.delete(session.sessionId);
      return null;
    }

    try {
      await dependencies.converseApi.validate(session.converseSessionToken, { sourceDigest });
      return session;
    } catch (error) {
      if (!isAuthenticationFailure(error)) {
        throw error;
      }

      await dependencies.sessionStore.delete(session.sessionId);
      return null;
    }
  };

  const resolveAgentChannelCredential = async (
    accessToken: string,
    sourceDigest?: string,
  ): Promise<AccessSessionRecord | null> => {
    try {
      const issuedAt = now();
      const exchange = await dependencies.converseApi.exchange({
        launchToken: accessToken,
        client: { name: "radioso-mcp-server" },
      }, { sourceDigest });
      await dependencies.converseApi.validate(exchange.sessionToken, { sourceDigest });

      return dependencies.sessionStore.save({
        accessToken,
        clientName: "radioso-mcp-converse",
        converseSessionToken: exchange.sessionToken,
        expiresAt: new Date(exchange.expiresAt),
        issuedAt,
        conversationId: exchange.conversationId,
        sessionId: `converse_${randomUUID()}`,
      });
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        return null;
      }

      throw error;
    }
  };

  const getValidatedSession = async (
    accessToken: string,
    sourceDigest?: string,
  ): Promise<AccessSessionRecord | null> => {
    const session = await dependencies.sessionStore.getByAccessToken(accessToken, now());
    return session ? validateConverseSession(session, sourceDigest) : null;
  };

  const resolveBearerSession = (accessToken: string, sourceDigest?: string): Promise<AccessSessionRecord | null> => {
    const resolutionKey = `${hashToken(accessToken)}:${sourceDigest ?? "unknown"}`;
    const pending = pendingBearerResolutions.get(resolutionKey);
    if (pending) {
      return pending;
    }

    const resolution = (async () =>
      (await getValidatedSession(accessToken, sourceDigest)) ?? resolveAgentChannelCredential(accessToken, sourceDigest))();
    pendingBearerResolutions.set(resolutionKey, resolution);

    const clearPendingResolution = (): void => {
      if (pendingBearerResolutions.get(resolutionKey) === resolution) {
        pendingBearerResolutions.delete(resolutionKey);
      }
    };
    void resolution.then(clearPendingResolution, clearPendingResolution);

    return resolution;
  };

  return {
    async getRequestAuthInfo(accessToken) {
      const session = await getValidatedSession(accessToken);
      return session ? toMcpRequestAuthInfo(session) : null;
    },
    getSession: getValidatedSession,
    async resolveBearerSession(accessToken, sourceDigest) {
      return resolveBearerSession(accessToken, sourceDigest);
    },
    recordSuccessfulUse(session, sourceDigest) {
      if (!session.converseSessionToken || pendingUseNotifications.has(session.sessionId)) {
        return;
      }
      const currentTime = now().getTime();
      for (const [sessionId, notifiedAt] of lastSuccessfulUseNotifications) {
        if (currentTime - notifiedAt >= SUCCESSFUL_USE_REFRESH_MS) {
          lastSuccessfulUseNotifications.delete(sessionId);
        }
      }
      const previous = lastSuccessfulUseNotifications.get(session.sessionId);
      if (previous !== undefined) {
        return;
      }

      pendingUseNotifications.add(session.sessionId);
      let notification: Promise<void>;
      try {
        notification = dependencies.converseApi.recordUse(session.converseSessionToken, { sourceDigest });
      } catch {
        pendingUseNotifications.delete(session.sessionId);
        return;
      }
      void notification.then(
        () => lastSuccessfulUseNotifications.set(session.sessionId, now().getTime()),
        () => undefined,
      ).finally(() => pendingUseNotifications.delete(session.sessionId));
    },
  };
};
