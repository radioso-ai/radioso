import type { InternalClientConfig } from "./config.js";
import { normalizeError, parseErrorResponse } from "./errors.js";

type QueryValue = string | number | boolean | null | undefined;

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string => {
  const url = new URL(path, `${baseUrl}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
};

const buildHeaders = (
  config: InternalClientConfig,
  headers?: HeadersInit,
  body?: BodyInit | null,
): Headers => {
  const result = new Headers(config.headers);
  const extra = new Headers(headers);

  for (const [key, value] of extra.entries()) {
    result.set(key, value);
  }

  result.set("Authorization", `Bearer ${config.apiToken}`);
  if (!result.has("Accept")) {
    result.set("Accept", "application/json");
  }

  if (body && !(body instanceof FormData) && !result.has("Content-Type")) {
    result.set("Content-Type", "application/json");
  }

  return result;
};

export interface JsonRequestOptions {
  method: string;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: HeadersInit;
}

export const requestJson = async <T>(
  config: InternalClientConfig,
  options: JsonRequestOptions,
): Promise<T> => {
  try {
    const body =
      options.body === undefined
        ? undefined
        : options.body instanceof FormData
          ? options.body
          : JSON.stringify(options.body);

    const response = await config.fetch(buildUrl(config.baseUrl, options.path, options.query), {
      method: options.method,
      headers: buildHeaders(config, options.headers, body),
      body,
    });

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return await response.json() as T;
  } catch (error) {
    throw normalizeError(error);
  }
};

export const requestStream = async (
  config: InternalClientConfig,
  options: JsonRequestOptions,
): Promise<Response> => {
  try {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await config.fetch(buildUrl(config.baseUrl, options.path, options.query), {
      method: options.method,
      headers: buildHeaders(config, options.headers, body),
      body,
    });

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    return response;
  } catch (error) {
    throw normalizeError(error);
  }
};
