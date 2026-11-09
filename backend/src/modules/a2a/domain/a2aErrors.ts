import { isStructuredAppError } from "../../../shared/domain/errors.js";
import { USAGE_LIMIT_EXCEEDED_CODE } from "../../../shared/domain/usageLimitPolicy.js";

/** The domain A2A's own errors carry in `google.rpc.ErrorInfo`. */
const A2A_ERROR_DOMAIN = "a2a-protocol.org";

/** The domain Radioso's own reasons carry, so a client never mistakes one for an A2A error. */
const RADIOSO_ERROR_DOMAIN = "radioso.ai";

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/**
 * JSON-RPC 2.0's own errors and A2A v1.0's (spec §5.4), by the `ErrorInfo.reason` each carries:
 * the error's name in UPPER_SNAKE_CASE without the `Error` suffix (§10.6).
 */
const A2A_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
  TASK_NOT_FOUND: { code: -32001, message: "Task not found" },
  TASK_NOT_CANCELABLE: { code: -32002, message: "Task cannot be canceled" },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { code: -32003, message: "Push notifications are not supported" },
  UNSUPPORTED_OPERATION: { code: -32004, message: "This operation is not supported" },
  CONTENT_TYPE_NOT_SUPPORTED: { code: -32005, message: "Only text parts are supported" },
  VERSION_NOT_SUPPORTED: { code: -32009, message: "A2A-Version 1.0 is required" },
} as const;

type A2aErrorName = keyof typeof A2A_ERRORS;

/**
 * Radioso's reasons. A context the server cannot read is bad params (-32602), as the spec names it.
 * The rest are server conditions; they use -32000, the one implementation-defined server code
 * outside the -32001..-32099 range A2A reserves for its own errors (§9.5).
 */
const RADIOSO_ERRORS = {
  CONTEXT_NOT_FOUND: { code: -32602, message: "Context not found" },
  TURN_SUPERSEDED: { code: -32000, message: "A newer message in this context replaced this one" },
  TURN_IN_PROGRESS: { code: -32000, message: "This message is still being answered" },
  USAGE_LIMIT_EXCEEDED: { code: -32000, message: "Workspace usage limit exceeded" },
} as const;

type RadiosoErrorReason = keyof typeof RADIOSO_ERRORS;

/**
 * A JSON-RPC error this binding answers with. It names a reason and a domain and nothing else:
 * no message text, id, slot value, or identity ever goes into an error (FR-013).
 */
export class A2aRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason: string,
    readonly domain: string,
  ) {
    super(message);
    this.name = "A2aRpcError";
  }
}

export const a2aError = (name: A2aErrorName): A2aRpcError =>
  new A2aRpcError(A2A_ERRORS[name].code, A2A_ERRORS[name].message, name, A2A_ERROR_DOMAIN);

export const radiosoError = (reason: RadiosoErrorReason): A2aRpcError =>
  new A2aRpcError(RADIOSO_ERRORS[reason].code, RADIOSO_ERRORS[reason].message, reason, RADIOSO_ERROR_DOMAIN);

export type JsonRpcId = string | number | null;

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data: [{ "@type": string; reason: string; domain: string; metadata: Record<string, never> }];
  };
}

export const jsonRpcErrorResponse = (id: JsonRpcId, error: A2aRpcError): JsonRpcErrorResponse => ({
  jsonrpc: "2.0",
  id,
  error: {
    code: error.code,
    message: error.message,
    data: [{ "@type": ERROR_INFO_TYPE, reason: error.reason, domain: error.domain, metadata: {} }],
  },
});

/**
 * The turn failures a caller can act on, as this binding's errors: a newer message on the same
 * context replaced this turn, or the workspace is over its quota. Anything else is not the
 * caller's to handle and goes to the shared error handler, which reports faults.
 */
export const rpcErrorForTurnFailure = (error: unknown): A2aRpcError | null => {
  if (!isStructuredAppError(error)) {
    return null;
  }
  if (error.code === "chat_turn_superseded") {
    return radiosoError("TURN_SUPERSEDED");
  }
  if (error.code === USAGE_LIMIT_EXCEEDED_CODE) {
    return radiosoError("USAGE_LIMIT_EXCEEDED");
  }
  return null;
};
