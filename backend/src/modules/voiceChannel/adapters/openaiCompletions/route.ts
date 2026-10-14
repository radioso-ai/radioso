import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";

import { markHttpResponseFailed } from "../../../../app/http/middleware/httpResponseCompletion.js";
import { consumeSseWithDisconnectCeiling } from "../../../../app/http/shared/sseDisconnectCeiling.js";
import { badRequest, notFound } from "../../../../shared/domain/errors.js";
import type { AppLogger } from "../../../../shared/observability/logger.js";
import type { VoiceTurnEvent, VoiceTurnInput, VoiceTurnPort } from "../../domain.js";
import {
  COMPLETION_ERROR_FRAME,
  createCompletionChunkRenderer,
  renderCompletion,
  type CompletionIdentity,
} from "./completionsPresenter.js";
import { findCompletionsDialect, sessionKeyFor, type CompletionsDialect } from "./dialects.js";
import { completionsRequestSchema, utteranceOf } from "./requestSchema.js";

const COMPLETIONS_PATH = "/:agentId/voice/:dialect/v1/chat/completions";
const CONVERSATION_ID_HEADER = "X-Radioso-Conversation-Id";
const DEFAULT_MODEL_NAME = "radioso";
// Matches the `voice_sessions.session_key` CHECK.
const MAX_SESSION_KEY_LENGTH = 256;

interface VoiceCaller {
  workspaceId: string;
  agentId: string;
}

/** What the HTTP layer contributes: who the caller is, and the budget its turns spend. */
interface CompletionsAdmission {
  /** Authenticate the bearer credential for the path's `:agentId` and charge its turn budget. */
  handlers: readonly RequestHandler[];
  /** The caller the handlers admitted. */
  callerOf(res: Response): VoiceCaller;
  /** Called once per request accepted for a turn, before the turn runs. */
  onTurnAccepted(res: Response): void;
}

interface CompletionsRouteDependencies {
  turns: VoiceTurnPort;
  admission: CompletionsAdmission;
  logger: Pick<AppLogger, "warn">;
  /** Overrides `CHAT_BEHAVIOR.streaming.disconnectAbortCeilingMs`; tests only. */
  disconnectAbortCeilingMs?: number;
}

const requireDialect = (name: unknown): CompletionsDialect => {
  const dialect = typeof name === "string" ? findCompletionsDialect(name) : null;
  if (!dialect) {
    throw notFound("Unknown voice dialect");
  }
  return dialect;
};

const resolveDialect: RequestHandler = (req, _res, next) => {
  try {
    requireDialect(req.params.dialect);
    next();
  } catch (error) {
    next(error);
  }
};

const turnInputFor = (
  req: Request,
  caller: VoiceCaller,
  dialect: CompletionsDialect,
  logger: Pick<AppLogger, "warn">,
): {
  input: VoiceTurnInput;
  model: string;
  stream: boolean;
} => {
  const parsed = completionsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Invalid chat completions request", parsed.error.flatten());
  }
  const utterance = utteranceOf(parsed.data);
  if (!utterance) {
    throw badRequest("The request has no user message to answer");
  }
  const request = { headers: req.headers, body: req.body as unknown };
  const sessionKey = sessionKeyFor(dialect, request);
  if (!sessionKey || sessionKey.length > MAX_SESSION_KEY_LENGTH) {
    // The likeliest cause is a vendor-side setting, so name where to look and nothing the caller said.
    logger.warn({ dialect: dialect.id, agentId: caller.agentId }, "Voice request carries no usable session key");
    throw badRequest(`The request carries no usable voice session key for the ${dialect.id} dialect`);
  }
  return {
    input: {
      session: { workspaceId: caller.workspaceId, agentId: caller.agentId, vendor: dialect.id, sessionKey },
      transport: dialect.transportDefault,
      utterance,
    },
    model: parsed.data.model ?? DEFAULT_MODEL_NAME,
    stream: parsed.data.stream ?? false,
  };
};

const openEventStream = (res: Response, conversationId: string | null): void => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (conversationId) {
    res.setHeader(CONVERSATION_ID_HEADER, conversationId);
  }
  res.flushHeaders();
};

/**
 * Drains the turn the way the REST agent channel does: after a disconnect the turn may still
 * finish and persist, and it is aborted only once the post-disconnect ceiling passes.
 */
interface TurnDrain {
  res: Response;
  events: AsyncIterable<VoiceTurnEvent>;
  abort: AbortController;
  disconnectAbortCeilingMs?: number;
}

const drainTurn = async (
  drain: TurnDrain,
  onEvent: (event: VoiceTurnEvent) => void,
): Promise<{ disconnected: boolean }> => {
  const { res } = drain;
  try {
    const result = await consumeSseWithDisconnectCeiling({
      response: res,
      events: drain.events,
      onEvent,
      onDisconnectCeilingExceeded: () => drain.abort.abort(),
      disconnectAbortCeilingMs: drain.disconnectAbortCeilingMs,
    });
    if (result.ceilingExceeded) {
      markHttpResponseFailed(res);
    }
    return { disconnected: result.disconnected };
  } catch (error) {
    markHttpResponseFailed(res);
    throw error;
  }
};

const streamCompletion = async (drain: TurnDrain, identity: CompletionIdentity): Promise<void> => {
  const { res } = drain;
  const render = createCompletionChunkRenderer(identity);
  let conversationId: string | null = null;
  try {
    await drainTurn(drain, (event) => {
      if (event.type === "conversation") {
        conversationId = event.conversationId;
      }
      const frames = render(event);
      if (frames.length === 0 || res.destroyed || res.writableEnded) {
        return;
      }
      if (!res.headersSent) {
        openEventStream(res, conversationId);
      }
      for (const frame of frames) {
        res.write(frame);
      }
    });
  } catch (error) {
    if (res.headersSent && !res.destroyed && !res.writableEnded) {
      res.write(COMPLETION_ERROR_FRAME);
    }
    throw error;
  } finally {
    if (res.headersSent && !res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
};

const answerCompletion = async (drain: TurnDrain, identity: CompletionIdentity): Promise<void> => {
  const { res } = drain;
  const collected: VoiceTurnEvent[] = [];
  const { disconnected } = await drainTurn(drain, (event) => collected.push(event));
  if (disconnected) {
    return;
  }
  const conversation = collected.find(
    (event): event is Extract<VoiceTurnEvent, { type: "conversation" }> => event.type === "conversation",
  );
  if (conversation) {
    res.setHeader(CONVERSATION_ID_HEADER, conversation.conversationId);
  }
  res.status(200).json(renderCompletion(identity, collected));
};

/**
 * `POST /:agentId/voice/:dialect/v1/chat/completions` — an OpenAI-compatible chat-completions
 * endpoint a voice runtime calls as its custom LLM, one request per caller turn. The dialect says
 * where the vendor puts its session key; everything else is the same wire.
 */
export const registerOpenAiCompletionsRoute = (router: Router, dependencies: CompletionsRouteDependencies): void => {
  router.post(COMPLETIONS_PATH, resolveDialect, ...dependencies.admission.handlers, async (req, res, next) => {
    try {
      const dialect = requireDialect(req.params.dialect);
      const { input, model, stream } = turnInputFor(
        req,
        dependencies.admission.callerOf(res),
        dialect,
        dependencies.logger,
      );
      const identity: CompletionIdentity = {
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model,
      };
      dependencies.admission.onTurnAccepted(res);
      const abort = new AbortController();
      const drain: TurnDrain = {
        res,
        events: dependencies.turns.runTurn(input, abort.signal),
        abort,
        disconnectAbortCeilingMs: dependencies.disconnectAbortCeilingMs,
      };
      await (stream ? streamCompletion : answerCompletion)(drain, identity);
    } catch (error) {
      // A started stream already ended with its error frame, and the turn logged the failure;
      // Express would only destroy the socket under the frame.
      if (res.headersSent) {
        return;
      }
      next(error);
    }
  });
};
