import { randomUUID } from "node:crypto";

import type { ConverseApiAdapter, ConverseSessionExchangeRequest } from "../converseApiAdapter.js";
import { RadiosoApiError } from "../converseApiAdapter.js";
import { toMcpRequestAuthInfo, type McpRequestAuthInfo } from "./authInfo.js";
import type { AccessSessionRecord, SessionStore } from "./sessionStore.js";
import { hashToken } from "./token.js";
import { toToolCatalogKey } from "./toolCatalogKey.js";

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

interface AuthServiceDependencies {
  converseApi: ConverseApiAdapter;
  now?: () => Date;
  sessionStore: SessionStore;
  /** Operator-facing warnings about a degraded exchange; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface AuthService {
  getRequestAuthInfo(accessToken: string): Promise<McpRequestAuthInfo | null>;
  getSession(accessToken: string): Promise<AccessSessionRecord | null>;
  resolveBearerSession(accessToken: string, sourceDigest?: string): Promise<AccessSessionRecord | null>;
  /**
   * Opens or reuses a credential-free session on a public agent. `walkInKey` is the
   * caller's own handle for the conversation, carried in `Mcp-Session-Id`; the server
   * mints one on first contact and the client echoes it, which is how a walk-in caller
   * keeps one conversation without holding a credential.
   */
  resolveWalkInSession(input: {
    publicId: string;
    walkInKey?: string | null;
    sourceDigest?: string;
  }): Promise<{ session: AccessSessionRecord; walkInKey: string } | null>;
  recordSuccessfulUse(session: AccessSessionRecord, sourceDigest?: string): void;
}

const defaultNow = () => new Date();
const SUCCESSFUL_USE_REFRESH_MS = 5 * 60_000;
/**
 * A walk-in handle is opaque and caller-echoed, so it is bounded structurally and
 * namespaced by public id — one caller's handle can never name another agent's session.
 */
const WALK_IN_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const WALK_IN_STORE_PREFIX = "radioso-walk-in:";

const isAuthenticationFailure = (error: unknown): boolean =>
  error instanceof RadiosoApiError && (error.status === 401 || error.status === 403);

const isMissingRoute = (error: unknown): boolean =>
  error instanceof RadiosoApiError && error.status === 404;

export const createAuthService = (dependencies: AuthServiceDependencies): AuthService => {
  const now = dependencies.now ?? defaultNow;
  const warn = dependencies.warn ?? console.warn;
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

  /**
   * A backend without the tools route answers 404; the session then carries the static
   * catalog (`ask_agent` and the documentation tools) rather than failing every exchange.
   * Any other failure is the exchange's own.
   */
  const readToolCatalog = async (sessionToken: string, sourceDigest?: string) => {
    try {
      return (await dependencies.converseApi.tools(sessionToken, { sourceDigest })).tools;
    } catch (error) {
      if (!isMissingRoute(error)) {
        throw error;
      }
      warn("The Radioso backend has no agent tool catalog route (GET /api/v1/mcp/converse/tools answered 404); serving the static tools only.");
      return [];
    }
  };

  const openConverseSession = async (input: {
    body: ConverseSessionExchangeRequest;
    /** The store key this session is reachable by on later requests. */
    storeKey: string;
    sessionIdPrefix: string;
    sourceDigest?: string;
  }): Promise<AccessSessionRecord | null> => {
    try {
      const issuedAt = now();
      const exchange = await dependencies.converseApi.exchange(input.body, { sourceDigest: input.sourceDigest });
      await dependencies.converseApi.validate(exchange.sessionToken, { sourceDigest: input.sourceDigest });
      // The catalog is read once here and pinned to the session: every MCP instance that
      // later serves this session renders the same tools, and a routine exposed after this
      // point appears when the client opens its next session.
      const tools = await readToolCatalog(exchange.sessionToken, input.sourceDigest);

      return dependencies.sessionStore.save({
        accessToken: input.storeKey,
        clientName: "radioso-mcp-converse",
        converseSessionToken: exchange.sessionToken,
        expiresAt: new Date(exchange.expiresAt),
        issuedAt,
        conversationId: exchange.conversationId,
        sessionId: `${input.sessionIdPrefix}_${randomUUID()}`,
        toolCatalog: { key: toToolCatalogKey(tools), tools },
      });
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        return null;
      }

      throw error;
    }
  };

  const resolveAgentChannelCredential = (
    accessToken: string,
    sourceDigest?: string,
  ): Promise<AccessSessionRecord | null> => openConverseSession({
    body: { launchToken: accessToken, client: { name: "radioso-mcp-server" } },
    storeKey: accessToken,
    sessionIdPrefix: "converse",
    sourceDigest,
  });

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
    async resolveWalkInSession({ publicId, walkInKey, sourceDigest }) {
      const key = WALK_IN_KEY_PATTERN.test(walkInKey ?? "") ? walkInKey as string : randomUUID();
      const storeKey = `${WALK_IN_STORE_PREFIX}${publicId}:${key}`;
      const existing = await getValidatedSession(storeKey, sourceDigest);
      if (existing) {
        return { session: existing, walkInKey: key };
      }
      const session = await openConverseSession({
        body: { publicId, client: { name: "radioso-mcp-server" } },
        storeKey,
        sessionIdPrefix: "walkin",
        sourceDigest,
      });
      return session ? { session, walkInKey: key } : null;
    },
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
