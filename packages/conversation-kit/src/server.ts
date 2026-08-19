import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import type { ConversationAgentConfig, Directive, Routine } from "@radioso/conversation-contract";

import { createConversationKit, type ConversationKit, type CreateConversationKitOptions } from "./composition.js";
import { isDirectiveCoherenceError } from "./directiveCoherenceError.js";
import { parseTurnRequestBody, isRecord, type TurnResponseBody } from "./httpTypes.js";
import { createConversationKitClient, type ConversationKitClient } from "./sdk.js";

export interface CreateConversationKitServerOptions {
  kit?: ConversationKit;
  kitOptions?: CreateConversationKitOptions;
  client?: ConversationKitClient;
}

export interface ListenOptions {
  port?: number;
  host?: string;
}

export interface ConversationKitListenAddress {
  host: string;
  port: number;
  url: string;
}

export interface ConversationKitServer {
  listen(options?: ListenOptions): Promise<ConversationKitListenAddress>;
  close(): Promise<void>;
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const sendNoContent = (response: ServerResponse): void => {
  response.writeHead(204);
  response.end();
};

const parsePathSegments = (request: IncomingMessage): string[] => {
  const url = new URL(request.url ?? "/", "http://conversation-kit.local");
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
};

const parseStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const parseAgentInput = (value: unknown): Omit<ConversationAgentConfig, "id"> & { id?: string } => {
  if (!isRecord(value)) {
    throw new Error("invalid_agent_request");
  }
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    instructions: parseStringArray(value.instructions),
    defaultLocale: typeof value.defaultLocale === "string" || value.defaultLocale === null
      ? value.defaultLocale
      : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const parseDirectiveInput = (value: unknown): Directive => {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.action !== "string") {
    throw new Error("invalid_directive_request");
  }
  const condition = value.condition;
  if (!isRecord(condition)) {
    throw new Error("invalid_directive_request");
  }
  const parsedCondition = condition.kind === "always"
    ? { kind: "always" as const }
    : condition.kind === "contextual" && typeof condition.description === "string"
      ? { kind: "contextual" as const, description: condition.description }
      : null;
  if (!parsedCondition) {
    throw new Error("invalid_directive_request");
  }
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: value.name,
    condition: parsedCondition,
    action: value.action,
    priority: typeof value.priority === "number" ? value.priority : undefined,
    requiredCapabilities: parseStringArray(value.requiredCapabilities),
    dependsOn: parseStringArray(value.dependsOn),
    excludes: parseStringArray(value.excludes),
    description: typeof value.description === "string" ? value.description : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const parseRoutineStep = (value: unknown): Routine["steps"][number] => {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("invalid_routine_request");
  }
  if (value.kind !== "chat" && value.kind !== "skill" && value.kind !== "action" && value.kind !== "terminal") {
    throw new Error("invalid_routine_request");
  }
  return {
    id: value.id,
    kind: value.kind,
    action: typeof value.action === "string" ? value.action : undefined,
    skillName: typeof value.skillName === "string" ? value.skillName : undefined,
    actionType: typeof value.actionType === "string" ? value.actionType : undefined,
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const parseRoutineTransition = (value: unknown): Routine["transitions"][number] => {
  if (
    !isRecord(value) ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    typeof value.condition !== "string"
  ) {
    throw new Error("invalid_routine_request");
  }
  return {
    from: value.from,
    to: value.to,
    condition: value.condition,
  };
};

const parseRoutineInput = (value: unknown): Routine => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.rootStepId !== "string") {
    throw new Error("invalid_routine_request");
  }
  if (!Array.isArray(value.steps) || !Array.isArray(value.transitions)) {
    throw new Error("invalid_routine_request");
  }
  return {
    id: value.id,
    rootStepId: value.rootStepId,
    steps: value.steps.map(parseRoutineStep),
    transitions: value.transitions.map(parseRoutineTransition),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
};

const isBadRequest = (message: string): boolean =>
  message === "invalid_turn_request" ||
  message === "invalid_agent_request" ||
  message === "invalid_directive_request" ||
  message === "invalid_routine_request";

const sendError = (response: ServerResponse, error: unknown): void => {
  if (isDirectiveCoherenceError(error)) {
    sendJson(response, 409, {
      error: error.code,
      coherent: error.verdict.coherent,
      conflicts: error.verdict.conflicts,
      rationale: error.verdict.rationale,
    });
    return;
  }
  const message = error instanceof Error ? error.message : "unknown_error";
  sendJson(response, isBadRequest(message) ? 400 : 500, { error: message });
};

export const createConversationKitServer = (
  options: CreateConversationKitServerOptions,
): ConversationKitServer => {
  const kit = options.kit ?? createConversationKit(options.kitOptions);
  const client = options.client ?? createConversationKitClient({ ...options.kitOptions, kit });
  const server = http.createServer(async (request, response) => {
    try {
      const segments = parsePathSegments(request);
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && segments.length === 1 && segments[0] === "turn") {
        const body = parseTurnRequestBody(await readJsonBody(request));
        const existingSession = body.sessionId ? client.getSession(body.sessionId) : null;
        const authoredAgentId = body.agentId ?? existingSession?.agentId;
        if (authoredAgentId) {
          const session = existingSession ?? client.createSession({ id: body.sessionId, agentId: authoredAgentId });
          const reply = await client.sendMessage({
            sessionId: session.id,
            message: body.message,
            metadata: body.metadata,
          });
          const responseBody: TurnResponseBody = {
            sessionId: session.id,
            reply,
            traceId: "",
          };
          sendJson(response, 200, responseBody);
          return;
        }
        const result = await kit.runTurn({
          sessionId: body.sessionId,
          message: body.message,
          agent: body.agent,
          directives: body.directives,
          metadata: body.metadata,
        });
        const responseBody: TurnResponseBody = {
          sessionId: result.sessionId,
          reply: result.response,
          traceId: result.trace.traceId,
        };
        sendJson(response, 200, responseBody);
        return;
      }
      if (segments.length === 1 && segments[0] === "agents") {
        if (request.method === "GET") {
          sendJson(response, 200, { agents: client.listAgents() });
          return;
        }
        if (request.method === "POST") {
          const agent = client.createAgent(parseAgentInput(await readJsonBody(request)));
          sendJson(response, 201, { agent });
          return;
        }
      }
      if (segments.length === 2 && segments[0] === "agents") {
        const agentId = segments[1];
        if (request.method === "GET") {
          const agent = client.getAgent(agentId);
          sendJson(response, agent ? 200 : 404, agent ? { agent } : { error: "not_found" });
          return;
        }
        if (request.method === "PATCH" || request.method === "PUT") {
          const agent = client.updateAgent(agentId, parseAgentInput(await readJsonBody(request)));
          sendJson(response, agent ? 200 : 404, agent ? { agent } : { error: "not_found" });
          return;
        }
        if (request.method === "DELETE") {
          if (!client.deleteAgent(agentId)) {
            sendJson(response, 404, { error: "not_found" });
            return;
          }
          sendNoContent(response);
          return;
        }
      }
      if (segments.length === 3 && segments[0] === "agents" && segments[2] === "directives") {
        const agentId = segments[1];
        if (request.method === "GET") {
          sendJson(response, 200, { directives: client.listDirectives(agentId) });
          return;
        }
        if (request.method === "POST") {
          const directive = await client.createDirective(agentId, parseDirectiveInput(await readJsonBody(request)));
          sendJson(response, 201, { directive });
          return;
        }
      }
      if (segments.length === 4 && segments[0] === "agents" && segments[2] === "directives") {
        const agentId = segments[1];
        const directiveId = segments[3];
        if (request.method === "GET") {
          const directive = client.getDirective(agentId, directiveId);
          sendJson(response, directive ? 200 : 404, directive ? { directive } : { error: "not_found" });
          return;
        }
        if (request.method === "PATCH" || request.method === "PUT") {
          const directive = await client.updateDirective(agentId, directiveId, parseDirectiveInput(await readJsonBody(request)));
          sendJson(response, directive ? 200 : 404, directive ? { directive } : { error: "not_found" });
          return;
        }
        if (request.method === "DELETE") {
          if (!client.deleteDirective(agentId, directiveId)) {
            sendJson(response, 404, { error: "not_found" });
            return;
          }
          sendNoContent(response);
          return;
        }
      }
      if (segments.length === 1 && segments[0] === "routines") {
        if (request.method === "GET") {
          sendJson(response, 200, { routines: client.listRoutines() });
          return;
        }
        if (request.method === "POST") {
          const routine = client.createRoutine(parseRoutineInput(await readJsonBody(request)));
          sendJson(response, 201, { routine });
          return;
        }
      }
      if (segments.length === 2 && segments[0] === "routines") {
        const routineId = segments[1];
        if (request.method === "GET") {
          const routine = client.getRoutine(routineId);
          sendJson(response, routine ? 200 : 404, routine ? { routine } : { error: "not_found" });
          return;
        }
        if (request.method === "PATCH" || request.method === "PUT") {
          const routine = client.updateRoutine(routineId, parseRoutineInput(await readJsonBody(request)));
          sendJson(response, routine ? 200 : 404, routine ? { routine } : { error: "not_found" });
          return;
        }
        if (request.method === "DELETE") {
          if (!client.deleteRoutine(routineId)) {
            sendJson(response, 404, { error: "not_found" });
            return;
          }
          sendNoContent(response);
          return;
        }
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendError(response, error);
    }
  });

  return {
    async listen(options: ListenOptions = {}): Promise<ConversationKitListenAddress> {
      const host = options.host ?? "127.0.0.1";
      server.listen(options.port ?? 8787, host);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("conversation_kit_server_address_unavailable");
      }
      return {
        host,
        port: address.port,
        url: `http://${host}:${address.port}`,
      };
    },
    async close(): Promise<void> {
      if (!server.listening) {
        return;
      }
      server.close();
      await once(server, "close");
    },
  };
};
