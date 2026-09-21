import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import type { AuditLogger } from "../audit/auditLogger.js";
import { AuthServiceError } from "../auth/authService.js";
import { toMcpRequestAuthInfo } from "../auth/authInfo.js";
import type { AccessSessionRecord, SessionToolCatalog } from "../auth/sessionStore.js";
import { toToolCatalogKey } from "../auth/toolCatalogKey.js";
import type { RadiosoMcpConfig } from "../config.js";
import { createConverseApiAdapter } from "../converseApiAdapter.js";
import { createRadiosoMcpServer, getRemoteToolAuthInfo } from "../server.js";
import type { InternalMcpRequestAuthInfo, SessionMcpServerHandle, SessionMcpServerManager } from "./types.js";

const toInternalAuthInfo = (
  session: AccessSessionRecord,
  accessToken: string,
  sourceDigest?: string,
): InternalMcpRequestAuthInfo => ({
  ...toMcpRequestAuthInfo(session),
  accessToken,
  clientId: session.clientName ?? session.sessionId,
  scopes: ["ask_agent"],
  sourceDigest,
  token: accessToken,
});

/** A session persisted before catalogs were pinned sees the static tools only. */
const STATIC_TOOL_CATALOG: SessionToolCatalog = { key: toToolCatalogKey([]), tools: [] };

const DEFAULT_SERVER_CACHE_MAX_ENTRIES = 64;
const DEFAULT_SERVER_CACHE_IDLE_TTL_MS = 15 * 60_000;

export interface SessionServerCacheOptions {
  /** Distinct tool sets kept warm at once; the least recently used one goes first. */
  maxEntries?: number;
  /** A server nobody has used for this long is rebuilt on its next request. */
  idleTtlMs?: number;
  now?: () => number;
}

export interface SessionServerManagerDependencies {
  auditLogger?: AuditLogger;
  config: RadiosoMcpConfig;
  entryPoint?: "merged" | "standalone";
  serverCache?: SessionServerCacheOptions;
}

interface CachedServer {
  handle: SessionMcpServerHandle;
  lastUsedAt: number;
}

export const createSessionMcpServerManager = ({
  auditLogger,
  config,
  entryPoint = "standalone",
  serverCache = {},
}: SessionServerManagerDependencies): SessionMcpServerManager => {
  const maxEntries = serverCache.maxEntries ?? DEFAULT_SERVER_CACHE_MAX_ENTRIES;
  const idleTtlMs = serverCache.idleTtlMs ?? DEFAULT_SERVER_CACHE_IDLE_TTL_MS;
  const now = serverCache.now ?? Date.now;
  // Insertion order doubles as recency: a hit re-inserts its entry at the end. An evicted
  // server is simply dropped; a request still using it keeps its own reference, and the
  // JSON-response transport holds no timers or sockets that need closing.
  const servers = new Map<string, CachedServer>();
  const pendingServers = new Map<string, Promise<SessionMcpServerHandle>>();
  const converseAdapter = createConverseApiAdapter({
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    signingSecret: config.signingSecret,
  });

  const createSessionHandle = async (
    toolCatalog: SessionToolCatalog,
  ): Promise<SessionMcpServerHandle> => {
    const serverHandle = createRadiosoMcpServer({
      onToolError: async (tool, context, error) => {
        if (!auditLogger) {
          return;
        }

        await auditLogger.emit({
          eventType: error.code === "unsupported_capability"
            ? "upstream.unsupported_capability"
            : error.code.includes("forbidden") || error.code.includes("required") || error.code.includes("invalid")
            ? "tool.denied"
            : "tool.failed",
          metadata: {
            code: error.code,
            details: error.details,
            entryPoint,
            conversationId: context?.authInfo?.conversationId,
          },
          outcome: error.code.includes("invalid") ? "denied" : "error",
          sessionId: context?.authInfo?.sessionId,
          toolName: tool.name,
        });
      },
      onToolResult: async (tool, context) => {
        if (!auditLogger) {
          return;
        }

        await auditLogger.emit({
          eventType: "tool.executed",
          metadata: {
            entryPoint,
            conversationId: context.authInfo?.conversationId,
          },
          outcome: "success",
          sessionId: context.authInfo?.sessionId,
          toolName: tool.name,
        });
      },
      resolveExecutionContext: async (_tool, _rawArgs, ctx) => {
        const authInfo = getRemoteToolAuthInfo(ctx) as InternalMcpRequestAuthInfo | null;
        if (!authInfo?.accessToken || !authInfo.converseSessionToken) {
          throw new AuthServiceError("MCP request is missing authenticated session context.", "invalid_access_token");
        }

        const converseSessionToken = authInfo.converseSessionToken;

        return {
          authInfo,
          converseAdapter,
          converseSessionToken,
          serverContext: ctx,
        };
      },
      routineTools: toolCatalog.tools,
      serverName: config.serverName,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      // Stateless transport lets Cloud Run replace an idle instance without leaving
      // clients with an MCP protocol session identifier tied to that process.
      sessionIdGenerator: undefined,
    });

    await serverHandle.server.connect(transport);

    return {
      serverHandle,
      toolCatalogKey: toolCatalog.key,
      transport,
    };
  };

  const touch = (toolCatalogKey: string, cached: CachedServer): void => {
    servers.delete(toolCatalogKey);
    servers.set(toolCatalogKey, { ...cached, lastUsedAt: now() });
  };

  const readCached = (toolCatalogKey: string): SessionMcpServerHandle | null => {
    const cached = servers.get(toolCatalogKey);
    if (!cached) {
      return null;
    }
    if (now() - cached.lastUsedAt > idleTtlMs) {
      servers.delete(toolCatalogKey);
      return null;
    }
    touch(toolCatalogKey, cached);
    return cached.handle;
  };

  const store = (toolCatalogKey: string, handle: SessionMcpServerHandle): void => {
    servers.delete(toolCatalogKey);
    servers.set(toolCatalogKey, { handle, lastUsedAt: now() });
    while (servers.size > maxEntries) {
      const oldest = servers.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      servers.delete(oldest);
    }
  };

  return {
    async evict(toolCatalogKey) {
      servers.delete(toolCatalogKey);
    },
    async getOrCreate(session) {
      const toolCatalog = session.toolCatalog ?? STATIC_TOOL_CATALOG;
      const existing = readCached(toolCatalog.key);
      if (existing) {
        return existing;
      }

      const pending = pendingServers.get(toolCatalog.key);
      if (pending) {
        return pending;
      }

      const creation = createSessionHandle(toolCatalog).then((handle) => {
        store(toolCatalog.key, handle);
        return handle;
      }).finally(() => {
        pendingServers.delete(toolCatalog.key);
      });
      pendingServers.set(toolCatalog.key, creation);
      return creation;
    },
  };
};

export { toInternalAuthInfo };
