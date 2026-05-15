import type { IncomingMessage, ServerResponse } from "node:http";

import { toWebRequest, writeWebResponse } from "./nodeHttp.js";
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
      if (next) {
        next(error);
        return;
      }

      throw error;
    }
  };
};
