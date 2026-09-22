import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthService } from "../auth/authService.js";
import type { RuntimeStoreReadiness } from "../state/runtimeStores.js";
import { toWebRequest, writeWebResponse } from "./nodeHttp.js";
import { jsonRpcError, refuseUnservableMcpRequest, withMcpAcceptHeader } from "./requestHandler.js";
import { digestPeerSource } from "./preAuthSourceBudget.js";
import { toInternalAuthInfo } from "./sessionServerManager.js";
import type { SessionMcpServerManager } from "./types.js";
import type { RadiosoMcpConfig } from "../config.js";

const MCP_SESSION_HEADER = "mcp-session-id";

interface WalkInRouteDependencies {
  authService: Pick<AuthService, "resolveWalkInSession" | "recordSuccessfulUse">;
  config: Pick<RadiosoMcpConfig, "bindHost" | "bindPort" | "trustedProxyHops">;
  readiness?: RuntimeStoreReadiness;
  serverManager: SessionMcpServerManager;
}

/** Copies a response and names the walk-in handle the client should echo. */
const withWalkInSessionHeader = (response: Response, walkInKey: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", walkInKey);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

/**
 * An agent's own MCP endpoint, `/mcp/a/{publicId}`. It takes no credential: the public id
 * in the path is the whole request to connect, and the backend decides whether the agent's
 * walk-in door is open. Continuity comes from the protocol's own `Mcp-Session-Id` — the
 * server mints one on first contact, the client echoes it, and each handle maps to one
 * conversation. A client that does not echo it gets a fresh conversation per call, which
 * is degraded but never another caller's conversation.
 */
export const createWalkInRouteHandler = ({
  authService,
  config,
  readiness,
  serverManager,
}: WalkInRouteDependencies) =>
  async (req: IncomingMessage, res: ServerResponse, publicId: string): Promise<void> => {
    const request = await toWebRequest(req, `${config.bindHost}:${config.bindPort}`);
    const unservable = await refuseUnservableMcpRequest(request, readiness);
    if (unservable) {
      await writeWebResponse(res, unservable);
      return;
    }

    const sourceDigest = digestPeerSource(req, config.trustedProxyHops);
    const resolved = await authService.resolveWalkInSession({
      publicId,
      walkInKey: request.headers.get(MCP_SESSION_HEADER),
      sourceDigest,
    });
    if (!resolved) {
      await writeWebResponse(res, jsonRpcError(403, -32001, "This agent does not accept walk-in connections.", {
        code: "walk_in_unavailable",
      }));
      return;
    }

    const response = await serverManager.handleRequest(resolved.session, withMcpAcceptHeader(request), {
      // The walk-in handle stands in for the access token a credential-bound session
      // carries: it names this caller's session and nothing else.
      authInfo: toInternalAuthInfo(resolved.session, resolved.walkInKey, sourceDigest),
    });
    const completed = await writeWebResponse(res, withWalkInSessionHeader(response, resolved.walkInKey));
    if (completed && response.ok) {
      try {
        authService.recordSuccessfulUse(resolved.session, sourceDigest);
      } catch {
        // Completion notifications are best effort after the client response.
      }
    }
  };
