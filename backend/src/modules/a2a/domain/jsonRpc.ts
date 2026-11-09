import { a2aError, type A2aRpcError, type JsonRpcId } from "./a2aErrors.js";

/** The one protocol version this binding speaks; the `A2A-Version` request header must name it. */
const A2A_PROTOCOL_VERSION = "1.0";

/** The methods slice 1 serves. Every other A2A method is answered with its own error below. */
export const A2A_SERVED_METHODS = ["SendMessage", "GetTask", "ListTasks", "CancelTask"] as const;

export type A2aMethod = typeof A2A_SERVED_METHODS[number];

const STREAMING_METHODS = new Set(["SendStreamingMessage", "SubscribeToTask"]);
const PUSH_CONFIG_METHODS = new Set([
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
]);
const EXTENDED_CARD_METHOD = "GetExtendedAgentCard";

interface JsonRpcCall {
  id: string | number;
  method: A2aMethod;
  params: Record<string, unknown>;
}

type JsonRpcCallParse =
  | { ok: true; call: JsonRpcCall }
  | { ok: false; id: JsonRpcId; error: A2aRpcError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isServedMethod = (method: string): method is A2aMethod =>
  (A2A_SERVED_METHODS as readonly string[]).includes(method);

/** A request id this binding can echo: a string or a number. A2A has no notifications, so one is required. */
const usableId = (value: unknown): string | number | null =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;

const unservedMethodError = (method: string): A2aRpcError => {
  if (STREAMING_METHODS.has(method) || method === EXTENDED_CARD_METHOD) {
    return a2aError("UNSUPPORTED_OPERATION");
  }
  if (PUSH_CONFIG_METHODS.has(method)) {
    return a2aError("PUSH_NOTIFICATION_NOT_SUPPORTED");
  }
  return a2aError("METHOD_NOT_FOUND");
};

/**
 * The protocol version a request names: its `A2A-Version` header, or, with no header, the
 * `A2A-Version` query parameter (A2A v1.0 §3.6). The header wins when a request sends both.
 */
export const requestedA2aVersion = (input: { header: string | undefined; query: unknown }): string | undefined =>
  input.header ?? (typeof input.query === "string" ? input.query : undefined);

/**
 * Reads one JSON-RPC 2.0 request of the A2A v1.0 binding, in the order a client can act on:
 * the envelope (a batch, or anything that is not one request, is -32600), the protocol version
 * (an absent `A2A-Version` means 0.3, so it is -32009 like any other), then the method. Params are
 * only required to be an object here; each method's own shape is `requestParams.ts`'s.
 */
export const parseJsonRpcCall = (input: { body: unknown; version: string | undefined }): JsonRpcCallParse => {
  const { body } = input;
  if (!isRecord(body)) {
    return { ok: false, id: null, error: a2aError("INVALID_REQUEST") };
  }
  const id = usableId(body.id);
  if (id === null || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return { ok: false, id, error: a2aError("INVALID_REQUEST") };
  }
  if (input.version?.trim() !== A2A_PROTOCOL_VERSION) {
    return { ok: false, id, error: a2aError("VERSION_NOT_SUPPORTED") };
  }
  if (!isServedMethod(body.method)) {
    return { ok: false, id, error: unservedMethodError(body.method) };
  }
  if (!isRecord(body.params)) {
    return { ok: false, id, error: a2aError("INVALID_PARAMS") };
  }
  return { ok: true, call: { id, method: body.method, params: body.params } };
};

/**
 * The extensions a request activates: the URIs in its `A2A-Extensions` header (comma-separated,
 * possibly repeated) that this server supports, once each, in the order the client named them.
 */
export const activatedExtensions = (
  header: string | readonly string[] | undefined,
  supported: readonly string[],
): string[] => {
  const values = typeof header === "string" ? [header] : header ?? [];
  const requested = values.flatMap((value) => value.split(",")).map((uri) => uri.trim());
  return [...new Set(requested.filter((uri) => supported.includes(uri)))];
};
