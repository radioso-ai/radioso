import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { createConversationKit, type ConversationKit, type CreateConversationKitOptions } from "./composition.js";
import { parseTurnRequestBody, type TurnResponseBody } from "./httpTypes.js";

export interface CreateConversationKitServerOptions {
  kit?: ConversationKit;
  kitOptions?: CreateConversationKitOptions;
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

export const createConversationKitServer = (
  options: CreateConversationKitServerOptions,
): ConversationKitServer => {
  const kit = options.kit ?? createConversationKit(options.kitOptions);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && request.url === "/turn") {
        const body = parseTurnRequestBody(await readJsonBody(request));
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
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      sendJson(response, message === "invalid_turn_request" ? 400 : 500, { error: message });
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
