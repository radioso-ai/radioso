import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export const readRequestBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
};

export const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const body = await readRequestBody(req);
  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
};

export const toWebRequest = async (req: IncomingMessage, fallbackHost: string): Promise<Request> => {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const host = req.headers.host ?? fallbackHost;
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { headers, method });
  }

  const body = await readRequestBody(req);
  return new Request(url, {
    body: body.length > 0 ? body : undefined,
    duplex: "half",
    headers,
    method,
  });
};

export const writeJson = (res: ServerResponse, statusCode: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body);
};

export const writeJsonRpcError = (
  res: ServerResponse,
  statusCode: number,
  errorCode: number,
  message: string,
  data?: unknown,
): void => {
  writeJson(res, statusCode, {
    error: {
      code: errorCode,
      ...(data !== undefined ? { data } : {}),
      message,
    },
    id: null,
    jsonrpc: "2.0",
  });
};

export const writeWebResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.statusCode = response.status;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end(await response.text());
    return;
  }

  const stream = Readable.fromWeb(response.body as never);
  stream.pipe(res);
  await once(res, "finish");
};
