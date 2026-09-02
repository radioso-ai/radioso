import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccessSessionRecord } from "../auth/sessionStore.js";
import { isRequestBodyTooLargeError, toWebRequest, writeJsonRpcError, writeWebResponse } from "./nodeHttp.js";
import type { McpRequestHandler } from "./requestHandler.js";

export type ExpressLikeMcpMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => Promise<void>;

export const createExpressMcpMiddleware = (
  handler: McpRequestHandler,
  options: {
    fallbackHost: string;
    onSuccessfulResponse?: (session: AccessSessionRecord, sourceDigest?: string) => void | Promise<void>;
    sourceDigest?: (req: IncomingMessage) => string;
  },
): ExpressLikeMcpMiddleware => {
  return async (req, res, next): Promise<void> => {
    try {
      const request = await toWebRequest(req, options.fallbackHost);
      const handled = await handler(request, options.sourceDigest?.(req));
      const responseClassifier = createMcpResponseClassifier(handled.response);
      const completed = await writeWebResponse(res, handled.response, {
        observeBodyChunk: responseClassifier.observe,
      });
      const successful = completed && responseClassifier.isSuccessful();
      if (completed && successful && handled.successfulUse && options.onSuccessfulResponse) {
        try {
          void Promise.resolve(options.onSuccessfulResponse(
            handled.successfulUse.session,
            handled.successfulUse.sourceDigest,
          )).catch(() => undefined);
        } catch {
          // Completion notifications are best effort after the client response.
        }
      }
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJsonRpcError(res, 413, -32000, "Request body is too large.", {
          code: error.code,
          maxBytes: error.maxBytes,
        });
        return;
      }

      if (next) {
        next(error);
        return;
      }

      throw error;
    }
  };
};

const hasJsonRpcFailure = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const payload = value as { error?: unknown; id?: unknown; jsonrpc?: unknown; result?: unknown };
  const hasValidId = payload.id === null
    || typeof payload.id === "string"
    || (typeof payload.id === "number" && Number.isFinite(payload.id));
  if (payload.jsonrpc !== "2.0" || !("id" in payload) || !hasValidId) return true;
  if ("error" in payload || !("result" in payload)) return true;
  return Boolean(
    payload.result
      && typeof payload.result === "object"
      && !Array.isArray(payload.result)
      && (payload.result as { isError?: unknown }).isError === true,
  );
};

const MAX_SEMANTIC_RESPONSE_BYTES = 8 * 1024 * 1024;

const jsonRpcPayloadSucceeded = (payload: unknown): boolean => {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.length > 0 && entries.every((entry) => !hasJsonRpcFailure(entry));
};

const parseSseData = (body: string): unknown[] | null => {
  const normalized = body.replace(/\r\n?/gu, "\n");
  if (!normalized.endsWith("\n\n")) return null;
  const events = normalized.split("\n\n");
  const payloads: unknown[] = [];
  for (const event of events) {
    const data = event.split("\n")
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line === "data" ? "" : line.slice(5).replace(/^ /u, ""))
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      return null;
    }
  }
  return payloads;
};

const createMcpResponseClassifier = (response: Response): {
  observe(chunk: Uint8Array): void;
  isSuccessful(): boolean;
} => {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  return {
    observe(chunk) {
      size += chunk.byteLength;
      if (size > MAX_SEMANTIC_RESPONSE_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      if (!exceeded) chunks.push(Buffer.from(chunk));
    },
    isSuccessful() {
      if (!response.ok || exceeded) return false;
      if (!response.body) return response.status === 202 || response.status === 204;
      const contentType = response.headers.get("content-type") ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        if (contentType.includes("application/json")) {
          return jsonRpcPayloadSucceeded(JSON.parse(body));
        }
        if (contentType.includes("text/event-stream")) {
          const payloads = parseSseData(body);
          return payloads !== null
            && payloads.length > 0
            && payloads.every(jsonRpcPayloadSucceeded);
        }
      } catch {
        return false;
      }
      return false;
    },
  };
};
