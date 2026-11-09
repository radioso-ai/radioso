import type { Request, Router } from "express";
import type { Kysely } from "kysely";

import {
  A2aAccessResolver,
  A2aMessageReceiptRepository,
  A2aSendMessageService,
  A2aService,
  A2aTaskReader,
  A2aTaskRepository,
  A2aTaskView,
  a2aWalkInPublicId,
  createA2aBodyErrorHandler,
  createA2aContextSealer,
  createA2aObserver,
  createA2aRoutes,
  type A2aMessageReceiptStore,
  type A2aTaskStore,
} from "../../modules/a2a/public.js";
import { AgentConverseAudit } from "../../modules/chat/composition.js";
import { AgentConversePrincipalIssuer } from "../../modules/settings/composition.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import { connectorEncryptionKeys } from "../config/env.js";
import { agentChannelChatRateLimiters } from "../http/middleware/agentChannelRateLimiter.js";
import {
  createMcpConverseMessagesRateLimiter,
  createMcpConverseMessagesSourceRateLimiter,
  createMcpConverseSourceRateLimiter,
} from "../http/middleware/mcpConverseSessionRateLimiter.js";
import { createWalkInConversationRateLimiter } from "../http/middleware/mcpConverseWalkInRateLimiter.js";
import { readPreAuthSourceDigest } from "../http/middleware/preAuthSourceRateLimiter.js";
import { extractBearerToken, publishConversePrincipal } from "../http/middleware/requireMcpConverseSession.js";
import { requirePublicChatPermission } from "../http/middleware/requirePermission.js";
import { CHAT_MESSAGE_MAX_LENGTH } from "../http/schemas/textInputLimits.js";
import type { AppDependencies } from "../server/types.js";
import {
  createAgentConverseOriginVerifier,
  createAgentConverseWalkInIssuer,
  createAgentConverseWalkInObserver,
} from "./agentConverseOrigins.js";
import { createA2aAgentDirectory, createA2aTranscript } from "./a2aTranscript.js";
import { createAgentConverseService } from "./agentConverse.js";

type A2aCompositionDependencies = Pick<
  AppDependencies,
  | "abuseControlService"
  | "accessGrantService"
  | "activeRoutineRuns"
  | "accountAccessService"
  | "agentPublication"
  | "agentRepository"
  | "agentToolCatalog"
  | "assistantChatService"
  | "auditService"
  | "chatHistoryService"
  | "connectorDb"
  | "conversationRepository"
  | "env"
  | "logger"
  | "messageRepository"
  | "metricsRegistry"
  | "workspaceInvalidationPublisher"
>;

/** Where the binding keeps tasks and receipts: Postgres in the app, an in-memory store in tests. */
interface A2aStores {
  tasks: A2aTaskStore;
  receipts: A2aMessageReceiptStore;
}

const createA2aStores = (db: Kysely<DB>): A2aStores => ({
  tasks: new A2aTaskRepository(db),
  receipts: new A2aMessageReceiptRepository(db),
});

/** The walk-in conversation door's audit `surface` for the A2A endpoint. */
const A2A_WALK_IN_SURFACE = "a2a_walk_in";

/** One reading of the credential, shared by the walk-in budget and admission. */
const bearerOf = (req: Request): string | null => extractBearerToken(req.header("authorization"));

/**
 * The A2A endpoint's router: converse principals issued for the `a2a` channel over the same origin
 * checks MCP uses, the converse turn, sealed contexts, and the task stores, behind the shared
 * converse budgets — the walk-in conversation budget with MCP, the turn budget keyed by grant or by
 * walk-in source as MCP's, and the update-read budgets for task reads.
 */
export const createA2aRouter = (
  dependencies: A2aCompositionDependencies,
  stores: A2aStores = createA2aStores(dependencies.connectorDb.kysely),
): Router => {
  const { metricsRegistry: metrics, logger } = dependencies;
  const walkInObserver = createAgentConverseWalkInObserver({ metrics, logger });
  const principals = new AgentConversePrincipalIssuer({
    channel: "a2a",
    accessGrantService: dependencies.accessGrantService,
    agentLookup: dependencies.agentRepository,
    // The MCP converse audit records MCP session validation; an A2A re-verification is not one.
    originVerifier: createAgentConverseOriginVerifier({
      accessGrantService: dependencies.accessGrantService,
      agentRepository: dependencies.agentRepository,
    }),
    walkInIssuer: createAgentConverseWalkInIssuer({ agentRepository: dependencies.agentRepository }),
    walkInObserver,
  });
  const converse = createAgentConverseService(dependencies, { audit: new AgentConverseAudit(dependencies.auditService) });
  const transcript = createA2aTranscript({
    history: dependencies.chatHistoryService,
    messages: dependencies.messageRepository,
    conversations: dependencies.conversationRepository,
  });
  const observer = createA2aObserver({ metrics, logger });
  const view = new A2aTaskView({ transcript });
  const service = new A2aService({
    access: new A2aAccessResolver({
      principals,
      sealer: createA2aContextSealer(connectorEncryptionKeys(dependencies.env)),
      tasks: stores.tasks,
      transcript,
      observer,
    }),
    send: new A2aSendMessageService({ converse, tasks: stores.tasks, receipts: stores.receipts, transcript, view, observer }),
    reads: new A2aTaskReader({ tasks: stores.tasks, transcript, view, observer }),
  });

  return createA2aRoutes({
    service,
    directory: createA2aAgentDirectory(dependencies),
    observer,
    maxMessageLength: CHAT_MESSAGE_MAX_LENGTH,
    middleware: {
      turnSourceLimit: createMcpConverseSourceRateLimiter(dependencies),
      readSourceLimit: createMcpConverseMessagesSourceRateLimiter(dependencies),
      walkInLimit: createWalkInConversationRateLimiter(
        dependencies,
        { walkInPublicId: (req) => a2aWalkInPublicId(req, bearerOf(req)), surface: A2A_WALK_IN_SURFACE },
        walkInObserver,
      ),
      turnLimits: [
        ...agentChannelChatRateLimiters(dependencies, "mcp"),
        requirePublicChatPermission(dependencies, "public_chat.turn.create"),
      ],
      readLimits: [
        createMcpConverseMessagesRateLimiter(dependencies),
        requirePublicChatPermission(dependencies, "public_chat.history.read.own"),
      ],
      admitPrincipal: publishConversePrincipal,
      sourceDigest: readPreAuthSourceDigest,
      bearer: bearerOf,
    },
  });
};

/** Renders a body that did not parse as JSON-RPC's parse error on the A2A path. */
export const createA2aErrorHandler = (dependencies: Pick<AppDependencies, "metricsRegistry" | "logger">) =>
  createA2aBodyErrorHandler(createA2aObserver({ metrics: dependencies.metricsRegistry, logger: dependencies.logger }));
