import { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";

import { A2A_CONVERSE_EXTENSION_URI } from "../../shared/domain/a2aConverseExtension.js";
import { AppError, notFound, RequestBodyParseError } from "../../shared/domain/errors.js";
import type { AgentConversePrincipal } from "../settings/contracts/agentConverseSession.js";
import type { A2aAgentDirectory } from "./contracts/ports.js";
import {
  a2aError,
  A2aRpcError,
  jsonRpcErrorResponse,
  rpcErrorForTurnFailure,
  type JsonRpcId,
} from "./domain/a2aErrors.js";
import { activatedExtensions, parseJsonRpcCall, requestedA2aVersion } from "./domain/jsonRpc.js";
import { parseCallParams, type A2aCallInput } from "./domain/requestParams.js";
import type { A2aAdmission } from "./services/a2aAccess.js";
import type { A2aObserver } from "./services/a2aObserver.js";
import type { A2aService } from "./services/a2aService.js";

/**
 * The HTTP-level pieces the application layer owns and hands in: the shared rate limits and how a
 * request names its caller. Each limiter answers 429 (`Retry-After`, `RateLimit-*`) through the
 * shared error handler before any method runs.
 */
interface A2aRouteMiddleware {
  /** The pre-auth source budget a converse turn spends; also publishes the source digest. */
  turnSourceLimit: RequestHandler;
  /** The pre-auth source budget a conversation-update read spends. */
  readSourceLimit: RequestHandler;
  /** The walk-in conversation budgets every door shares; spends only for a request opening a walk-in context. */
  walkInLimit: RequestHandler;
  /** Per-caller budgets and permission checks, keyed by the admitted principal. */
  turnLimits: readonly RequestHandler[];
  readLimits: readonly RequestHandler[];
  /** Publishes the admitted principal where the per-caller limits and permission checks read it. */
  admitPrincipal(res: Response, principal: AgentConversePrincipal): void;
  sourceDigest(res: Response): string | null;
  bearer(req: Request): string | null;
}

interface A2aRouteDependencies {
  service: A2aService;
  directory: A2aAgentDirectory;
  middleware: A2aRouteMiddleware;
  observer: A2aObserver;
  /** A message's bound: the chat message limit. */
  maxMessageLength: number;
}

const SUPPORTED_EXTENSIONS = [A2A_CONVERSE_EXTENSION_URI];

/** The card route's own bound on a public id: structural, and it keeps junk out of the lookup. */
const MAX_PUBLIC_ID_LENGTH = 64;

interface A2aCallLocals {
  call: { id: string | number; input: A2aCallInput; extensionActive: boolean };
  agent: { agentId: string; publicId: string };
  admission: A2aAdmission;
}

interface A2aLocals {
  a2a?: Partial<A2aCallLocals>;
  /** The method label and outcome `a2a_requests_total` counts this request under. */
  a2aMethod?: string;
  a2aOutcome?: string;
}

const localsOf = (res: Response): A2aLocals => res.locals as A2aLocals;

const callLocals = (res: Response): Partial<A2aCallLocals> => {
  const locals = localsOf(res);
  locals.a2a ??= {};
  return locals.a2a;
};

const isTurn = (input: A2aCallInput | undefined): boolean => input?.method === "SendMessage";

const sendRpcError = (res: Response, id: JsonRpcId, error: A2aRpcError): void => {
  localsOf(res).a2aOutcome = error.reason;
  res.status(error.code === a2aError("INTERNAL_ERROR").code ? 500 : 200).json(jsonRpcErrorResponse(id, error));
};

/** An answer the binding did not shape itself (404, 401/403, 429, any other 4xx, 5xx), as a bounded label. */
const httpOutcome = (statusCode: number): string => {
  if (statusCode === 404) return "not_found";
  if (statusCode === 401 || statusCode === 403) return "refused";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 413) return "payload_too_large";
  if (statusCode >= 500) return "error";
  return statusCode >= 400 ? "client_error" : "ok";
};

/** Runs the handlers in order, the way a route list would. */
const inSequence = (handlers: readonly RequestHandler[]): RequestHandler => (req, res, next) => {
  const run = (index: number, error?: unknown): void => {
    const handler = handlers[index];
    if (error !== undefined || !handler) {
      next(error);
      return;
    }
    void handler(req, res, (handlerError?: unknown) => run(index + 1, handlerError));
  };
  run(0);
};

/**
 * Who opens a walk-in context: a `SendMessage` that names no context and no task and presents no
 * credential, on the agent in the path. The walk-in budgets and the admission both ask this, with
 * the same bearer reading, so a request never opens a walk-in context it did not pay for.
 */
export const a2aWalkInPublicId = (req: Request, bearer: string | null): string | null => {
  if (bearer) {
    return null;
  }
  const body = req.body as { method?: unknown; params?: { message?: { contextId?: unknown; taskId?: unknown } } } | undefined;
  const message = body?.params?.message;
  if (body?.method !== "SendMessage" || message?.contextId || message?.taskId) {
    return null;
  }
  const publicId = req.params.publicId;
  return typeof publicId === "string" && publicId.length > 0 ? publicId : null;
};

/**
 * `POST /a2a/{publicId}`: the A2A v1.0 JSON-RPC binding (FR-010 to FR-014). The request is read and
 * validated before anything about the agent is looked up, so a malformed call costs nothing; then
 * the source budget, the agent (unknown, unpublished and deleted ids answer the card's 404), the
 * walk-in budget, admission, the caller's budget, and the method. JSON-RPC errors answer HTTP 200;
 * a refused credential, a missing agent, and a spent budget answer at the HTTP level.
 */
export const createA2aRoutes = (dependencies: A2aRouteDependencies): Router => {
  const router = Router({ mergeParams: true });
  const { middleware, observer } = dependencies;

  const observeRequest: RequestHandler = (_req, res, next) => {
    res.on("finish", () => {
      const locals = localsOf(res);
      observer.request({ method: locals.a2aMethod ?? null, outcome: locals.a2aOutcome ?? httpOutcome(res.statusCode) });
    });
    next();
  };

  const readCall: RequestHandler = (req, res, next) => {
    const extensions = activatedExtensions(req.headers["a2a-extensions"], SUPPORTED_EXTENSIONS);
    if (extensions.length > 0) {
      res.setHeader("A2A-Extensions", extensions.join(", "));
    }
    // A JSON body the shared body reader parsed is the only body this binding reads.
    const contentType = req.headers["content-type"];
    if (contentType !== undefined && !req.is("application/json")) {
      sendRpcError(res, null, a2aError("CONTENT_TYPE_NOT_SUPPORTED"));
      return;
    }
    const version = requestedA2aVersion({ header: req.header("a2a-version"), query: req.query["A2A-Version"] });
    const envelope = parseJsonRpcCall({ body: req.body, version });
    if (!envelope.ok) {
      sendRpcError(res, envelope.id, envelope.error);
      return;
    }
    localsOf(res).a2aMethod = envelope.call.method;
    const params = parseCallParams(envelope.call.method, envelope.call.params, { maxMessageLength: dependencies.maxMessageLength });
    if (!params.ok) {
      sendRpcError(res, envelope.call.id, params.error);
      return;
    }
    callLocals(res).call = { id: envelope.call.id, input: params.input, extensionActive: extensions.length > 0 };
    next();
  };

  const sourceLimit: RequestHandler = (req, res, next) =>
    (isTurn(callLocals(res).call?.input) ? middleware.turnSourceLimit : middleware.readSourceLimit)(req, res, next);

  const resolveAgent: RequestHandler = async (req, res, next) => {
    try {
      const publicId = String(req.params.publicId ?? "");
      const agent = publicId.length > 0 && publicId.length <= MAX_PUBLIC_ID_LENGTH
        ? await dependencies.directory.resolve(publicId)
        : null;
      if (!agent) {
        // Unknown, card switched off, unpublished, and deleted answer identically, as the card does.
        next(notFound("Not found"));
        return;
      }
      callLocals(res).agent = { agentId: agent.agentId, publicId };
      next();
    } catch (error) {
      next(error);
    }
  };

  const admit: RequestHandler = async (req, res, next) => {
    const locals = callLocals(res);
    const call = locals.call;
    const agent = locals.agent;
    if (!call || !agent) {
      next(new Error("A2A admission ran before the call and agent were read"));
      return;
    }
    try {
      const admission = await dependencies.service.admit(call.input, {
        agentId: agent.agentId,
        publicId: agent.publicId,
        bearer: middleware.bearer(req),
        sourceDigest: middleware.sourceDigest(res),
      });
      if (admission.kind === "refused") {
        const { statusCode, code } = admission.refusal;
        if (statusCode === 401) {
          res.setHeader("WWW-Authenticate", "Bearer");
        }
        next(new AppError(statusCode, statusCode === 401 ? "unauthorized" : "forbidden", "A2A access refused.", { code }));
        return;
      }
      if (admission.kind === "context") {
        middleware.admitPrincipal(res, admission.principal);
      }
      locals.admission = admission;
      next();
    } catch (error) {
      if (error instanceof A2aRpcError) {
        sendRpcError(res, call.id, error);
        return;
      }
      next(error);
    }
  };

  const callerLimits: RequestHandler = (req, res, next) => {
    const locals = callLocals(res);
    if (locals.admission?.kind !== "context") {
      // A ListTasks naming no context lists nothing and reads nothing; there is no caller to charge.
      next();
      return;
    }
    inSequence(isTurn(locals.call?.input) ? middleware.turnLimits : middleware.readLimits)(req, res, next);
  };

  const dispatch: RequestHandler = async (_req, res, next) => {
    const { call, admission } = callLocals(res);
    if (!call || !admission || admission.kind === "refused") {
      next(new Error("A2A dispatch ran before admission"));
      return;
    }
    try {
      const result = await dependencies.service.handle(call.input, admission, { extensionActive: call.extensionActive });
      localsOf(res).a2aOutcome = "ok";
      res.status(200).json({ jsonrpc: "2.0", id: call.id, result });
    } catch (error) {
      const rpcError = error instanceof A2aRpcError ? error : rpcErrorForTurnFailure(error);
      if (rpcError) {
        sendRpcError(res, call.id, rpcError);
        return;
      }
      next(error);
    }
  };

  router.post(
    "/",
    observeRequest,
    readCall,
    sourceLimit,
    resolveAgent,
    middleware.walkInLimit,
    admit,
    callerLimits,
    dispatch,
  );

  return router;
};

/**
 * A body that declared JSON and did not parse is refused by the shared body reader before this
 * router runs; on this path it is JSON-RPC's parse error (-32700) rather than a Radioso 400.
 */
export const createA2aBodyErrorHandler = (observer: A2aObserver): ErrorRequestHandler => (error, _req, res, next) => {
  if (!(error instanceof RequestBodyParseError) || res.headersSent) {
    next(error);
    return;
  }
  observer.request({ method: null, outcome: "PARSE_ERROR" });
  res.status(200).json(jsonRpcErrorResponse(null, a2aError("PARSE_ERROR")));
};
