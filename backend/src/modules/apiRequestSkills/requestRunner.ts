import type {
  PublicHttpRequest,
  PublicHttpRequestLimits,
  PublicHttpRequestResult,
} from "../../shared/infra/http/publicHttpRequest.js";
import { checkSkillOutputs, type SkillOutputDeclarations } from "../../shared/domain/skillDataContract/index.js";
import {
  API_REQUEST_LIMITS,
  type ApiConnectionTarget,
  type ApiRequestFailureReason,
  type ApiRequestMethod,
  type ApiRequestSkillOutcome,
} from "./domain.js";
import { outcomeForStatus, outcomeForTransportFailure } from "./outcomes.js";
import { placeApiRequest } from "./requestPlacement.js";

/** Sends one request under the egress policy; composition supplies the transport and its loopback rule. */
export type ApiRequestSender = (
  request: PublicHttpRequest,
  limits: PublicHttpRequestLimits,
) => Promise<PublicHttpRequestResult>;

type ParsedBody = { kind: "empty" } | { kind: "json"; value: unknown } | { kind: "not_json" };

export interface ApiRequestRun {
  outcome: ApiRequestSkillOutcome;
  reason?: ApiRequestFailureReason;
  /** The status the target answered with; null when no answer came back. */
  httpStatus: number | null;
  durationMs: number;
  /** The declared outputs, projected to their types, on `completed` only. */
  outputs: Record<string, unknown>;
  /** The required outputs the response left absent, on `response_mismatch`; names only. */
  missingOutputs?: string[];
  /** The param a path placeholder could not take, on `invalid_input`. */
  invalidParam?: string;
  /** The parsed body, kept only when the caller asked (the operator's test request); never for a skill run. */
  body?: unknown;
}

const credentialHeaders = (target: ApiConnectionTarget): Record<string, string> => {
  if (target.credential === null) return {};
  switch (target.authScheme) {
    case "bearer":
      return { authorization: `Bearer ${target.credential}` };
    case "basic":
      return { authorization: `Basic ${Buffer.from(target.credential, "utf8").toString("base64")}` };
    case "header":
      return target.authHeaderName ? { [target.authHeaderName.toLowerCase()]: target.credential } : {};
    case "none":
      return {};
  }
};

/** Header names lower-cased, so a default header and a request header never go out twice. */
const requestHeaders = (target: ApiConnectionTarget, hasBody: boolean): Record<string, string> => ({
  accept: "application/json",
  ...Object.fromEntries(Object.entries(target.defaultHeaders).map(([name, value]) => [name.toLowerCase(), value])),
  ...(hasBody ? { "content-type": "application/json" } : {}),
  ...credentialHeaders(target),
});

const parseBody = (body: Buffer): ParsedBody => {
  const text = body.toString("utf8");
  if (text.trim().length === 0) return { kind: "empty" };
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "not_json" };
  }
};

const settleOutputs = (
  check: ReturnType<typeof checkSkillOutputs>,
  base: Pick<ApiRequestRun, "httpStatus" | "durationMs" | "body">,
): ApiRequestRun => {
  switch (check.kind) {
    case "checked":
      return { outcome: "completed", ...base, outputs: check.outputs };
    case "mismatch":
      return { outcome: "failed", reason: "response_mismatch", ...base, outputs: {}, missingOutputs: check.missing };
    case "too_large":
      return { outcome: "failed", reason: "outputs_too_large", ...base, outputs: {} };
  }
};

/**
 * Runs one API request end to end: places the params, sends through the connection, and settles
 * the answer into an outcome and the declared outputs. The skill executor and the operator's test
 * request share it, so a test shows exactly what a routine would get.
 */
export const runApiRequest = async (input: {
  target: ApiConnectionTarget;
  method: ApiRequestMethod;
  path: string;
  params: Readonly<Record<string, unknown>>;
  outputs: Readonly<SkillOutputDeclarations>;
  send: ApiRequestSender;
  keepBody?: boolean;
}): Promise<ApiRequestRun> => {
  const placed = placeApiRequest({ baseUrl: input.target.baseUrl, method: input.method, path: input.path, params: input.params });
  if (placed.kind === "invalid_input") {
    return { outcome: "invalid_input", invalidParam: placed.param, httpStatus: null, durationMs: 0, outputs: {} };
  }
  const answer = await input.send(
    {
      method: input.method,
      url: placed.url,
      headers: requestHeaders(input.target, placed.body !== undefined),
      ...(placed.body === undefined ? {} : { body: placed.body }),
    },
    { timeoutMs: API_REQUEST_LIMITS.timeoutMs, maxResponseBytes: API_REQUEST_LIMITS.maxResponseBytes },
  );
  if (answer.kind === "failed") {
    return {
      ...outcomeForTransportFailure(answer.reason),
      httpStatus: answer.status ?? null,
      durationMs: answer.durationMs,
      outputs: {},
    };
  }
  const settled = outcomeForStatus(answer.status);
  const wantsOutputs = settled.outcome === "completed" && Object.keys(input.outputs).length > 0;
  const parsed = wantsOutputs || input.keepBody ? parseBody(answer.body) : { kind: "empty" as const };
  const base = {
    httpStatus: answer.status,
    durationMs: answer.durationMs,
    ...(input.keepBody ? { body: parsed.kind === "json" ? parsed.value : null } : {}),
  };
  if (!wantsOutputs) {
    return { ...settled, ...base, outputs: {} };
  }
  if (parsed.kind === "not_json") {
    return { outcome: "failed", reason: "non_json_response", ...base, outputs: {} };
  }
  if (parsed.kind === "empty") {
    // No body is no data: every output is absent, so a required one is still a mismatch.
    return settleOutputs(checkSkillOutputs(undefined, input.outputs, API_REQUEST_LIMITS.maxOutputBytes), base);
  }
  return settleOutputs(checkSkillOutputs(parsed.value, input.outputs, API_REQUEST_LIMITS.maxOutputBytes), base);
};
