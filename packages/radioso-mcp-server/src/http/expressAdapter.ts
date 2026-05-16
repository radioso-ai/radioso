import type { IncomingMessage, ServerResponse } from "node:http";

import { isRequestBodyTooLargeError, toWebRequest, writeJsonRpcError, writeWebResponse } from "./nodeHttp.js";
import type { McpRequestHandler } from "./requestHandler.js";

export type ExpressLikeMcpMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => Promise<void>;

export const createExpressMcpMiddleware = (
  handler: McpRequestHandler,
  options: { fallbackHost: string },
): ExpressLikeMcpMiddleware => {
  return async (req, res, next): Promise<void> => {
    try {
      const request = await toWebRequest(req, options.fallbackHost);
      const response = await handler(request);
      await writeWebResponse(res, response);
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
