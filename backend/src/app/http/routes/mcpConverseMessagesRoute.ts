import type { RequestHandler } from "express";

import type {
  ConversationUpdatePage,
  ConversationUpdateReader,
  ConversationUpdateWaiter,
} from "../../../modules/chat/contracts/index.js";
import type { AgentConverseSessionPort } from "../../../modules/settings/contracts/agentConverseSession.js";
import { badRequest } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { onSuccessfulHttpResponse } from "../middleware/httpResponseCompletion.js";
import type { McpConverseLocals } from "../middleware/requireMcpConverseSession.js";
import {
  MCP_CONVERSE_MESSAGES_PAGE_LIMIT,
  mcpConverseMessagesQuerySchema,
} from "../schemas/mcpConverseSchemas.js";

/** Outcome label of one call, for `mcp_converse_update_polls_total`. */
type UpdatePollOutcome = "immediate" | "woken" | "deadline";

/**
 * A converse session names a public session id; the conversation behind it is created
 * on the session's first turn. This is the narrow read that resolves the one from the
 * other — `ConversationRepositoryPort` satisfies it structurally.
 */
interface ConverseConversationLookup {
  listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; agentId?: string | null },
  ): Promise<{ conversations: { id: string }[] }>;
}

interface McpConverseMessagesHandlerDependencies {
  conversationUpdateReader: ConversationUpdateReader;
  conversationUpdateWaiter: ConversationUpdateWaiter;
  conversations: ConverseConversationLookup;
  sessionService: Pick<AgentConverseSessionPort, "recordSuccessfulUse">;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
}

/** A session that has not run a turn yet has no conversation, and nothing to wait for. */
const emptyPage = (): ConversationUpdatePage => ({
  messages: [],
  cursor: null,
  ownership: { state: "ai_owned" },
});

/**
 * Long-polls a converse session's conversation for messages after the caller's cursor.
 *
 * The read budget is spent once per call by the middleware in front of this handler,
 * never per poll tick: a caller that parks for 25 s costs at most ⌈25/2⌉ trivial keyset
 * reads and no held database connection, so a parked caller consumes a socket rather
 * than one of the pool's connections.
 */
export const createMcpConverseMessagesHandler = (
  dependencies: McpConverseMessagesHandlerDependencies,
): RequestHandler => async (req, res, next) => {
  try {
    const parsedQuery = mcpConverseMessagesQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      next(badRequest("Invalid request query", parsedQuery.error.flatten()));
      return;
    }
    const { cursor, waitMs } = parsedQuery.data;
    const { mcpConversePrincipal: principal } = res.locals as typeof res.locals & McpConverseLocals;

    const conversationId = await resolveConversationId(dependencies.conversations, principal);
    if (!conversationId) {
      respond(dependencies, res, principal, emptyPage(), "immediate");
      return;
    }

    const abort = new AbortController();
    req.on("close", () => abort.abort());
    const readPage = () => dependencies.conversationUpdateReader.read({
      workspaceId: principal.workspaceId,
      conversationId,
      ...(cursor ? { cursor } : {}),
      limit: MCP_CONVERSE_MESSAGES_PAGE_LIMIT,
    });

    let page = await readPage();
    let outcome: UpdatePollOutcome = "immediate";

    if (page.messages.length === 0 && waitMs > 0) {
      const deadline = Date.now() + waitMs;
      outcome = "deadline";
      while (!abort.signal.aborted) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        const reason = await dependencies.conversationUpdateWaiter.wait({
          conversationId,
          timeoutMs: remainingMs,
          signal: abort.signal,
        });
        // Re-read even when the waiter hit its deadline: a message can land in the
        // instant between the last tick and the deadline.
        page = await readPage();
        if (page.messages.length > 0) {
          outcome = "woken";
          break;
        }
        if (reason === "deadline") {
          break;
        }
      }
      if (abort.signal.aborted) {
        // The caller hung up; there is no one left to answer and nothing to charge.
        return;
      }
    }

    respond(dependencies, res, principal, page, outcome);
  } catch (error) {
    next(error);
  }
};

const resolveConversationId = async (
  conversations: ConverseConversationLookup,
  principal: McpConverseLocals["mcpConversePrincipal"],
): Promise<string | null> => {
  const page = await conversations.listPageByAnonymousSession(
    principal.workspaceId,
    principal.publicSessionId,
    { limit: 1, agentId: principal.agentId },
  );
  return page.conversations[0]?.id ?? null;
};

const respond = (
  dependencies: McpConverseMessagesHandlerDependencies,
  res: Parameters<RequestHandler>[1],
  principal: McpConverseLocals["mcpConversePrincipal"],
  page: ConversationUpdatePage,
  outcome: UpdatePollOutcome,
): void => {
  dependencies.metrics?.incrementCounter("mcp_converse_update_polls_total", {
    help: "MCP converse conversation-update reads by how the call ended.",
    labels: { outcome },
  });
  onSuccessfulHttpResponse(res, () => dependencies.sessionService.recordSuccessfulUse(principal));
  res.status(200).json(page);
};
