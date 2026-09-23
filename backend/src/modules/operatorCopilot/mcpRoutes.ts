import { timingSafeEqual } from "node:crypto";

import {
  createOperatorMcpRequestSignature,
  OperatorAdmissionRequestSchema,
  OperatorCatalogRequestSchema,
  OperatorInvocationRequestSchema,
  OPERATOR_SERVICE_AUTH_HEADERS,
  sha256Digest,
} from "@radioso/operator-mcp-contract";
import { Router, type Request, type RequestHandler } from "express";

import type { AppDependencies } from "../../app/server/types.js";
import { asError } from "../../shared/errors/asError.js";
import { OperatorMcpApplicationError } from "./mcpApplicationService.js";

type Dependencies = Pick<AppDependencies, "env" | "logger" | "operatorMcpApplicationService" | "operatorMcpReadiness">;
type OperatorMcpApplication = NonNullable<AppDependencies["operatorMcpApplicationService"]>;
type RouteName = "admissions" | "catalog" | "invocations";
const SERVICE_ID = "radioso-mcp-operator";
const CLOCK_SKEW_SECONDS = 30;

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requireServiceAuthentication = (dependencies: Dependencies): RequestHandler => (req, res, next) => {
  const secret = dependencies.env.OPERATOR_MCP_INTERNAL_SECRET;
  const service = req.header(OPERATOR_SERVICE_AUTH_HEADERS.service);
  const timestamp = req.header(OPERATOR_SERVICE_AUTH_HEADERS.timestamp);
  const nonce = req.header(OPERATOR_SERVICE_AUTH_HEADERS.nonce);
  const presentedDigest = req.header(OPERATOR_SERVICE_AUTH_HEADERS.bodyDigest);
  const presentedSignature = req.header(OPERATOR_SERVICE_AUTH_HEADERS.signature);
  if (!secret || service !== SERVICE_ID || !timestamp || !nonce || !presentedDigest || !presentedSignature) {
    res.status(401).json({ code: "unauthorized", message: "Unauthorized" });
    return;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1_000) - timestampSeconds) > CLOCK_SKEW_SECONDS) {
    res.status(401).json({ code: "unauthorized", message: "Unauthorized" });
    return;
  }
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const bodyDigest = sha256Digest(rawBody);
  const path = `${req.baseUrl}${req.path}`;
  const expected = createOperatorMcpRequestSignature({ secret, service, timestamp, nonce, method: req.method, path, bodyDigest });
  if (!equal(bodyDigest, presentedDigest) || !equal(expected, presentedSignature)) {
    res.status(401).json({ code: "unauthorized", message: "Unauthorized" });
    return;
  }
  next();
};

const statusFor = (error: OperatorMcpApplicationError): number => {
  if (error.code === "insufficient_scope") return 403;
  if (error.code === "budget_exhausted") return 429;
  if (error.code === "invalid_proof" || error.code === "proof_replay" || error.code === "invalid_admission") return 401;
  if (error.code === "invalid_arguments" || error.code === "operation_required" || error.code === "operation_conflict" || error.code === "unknown_tool") return 400;
  if (error.code === "missing_configuration") return 409;
  return 500;
};

const UNAVAILABLE = { code: "unavailable", message: "Operator capability is unavailable" };

/**
 * The edge mints the invocation id, and both the invocation receipt and the audit record are keyed
 * by it, so it is the field that joins a log line to the rest of the trail. Read it defensively:
 * the body may be exactly the value whose schema rejection is being reported.
 */
const invocationIdOf = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const candidate = body as { invocationId?: unknown; proof?: { invocationId?: unknown } | null };
  const value = candidate.invocationId ?? (candidate.proof && typeof candidate.proof === "object" ? candidate.proof.invocationId : undefined);
  return typeof value === "string" ? value : undefined;
};

type Failure = {
  readonly logger: Dependencies["logger"];
  readonly route: RouteName;
  readonly invocationId?: string;
};

const handleError = (
  error: unknown,
  res: { status(code: number): { json(value: unknown): void }; setHeader(name: string, value: string): void },
  failure: Failure,
): void => {
  if (error instanceof OperatorMcpApplicationError) {
    const status = statusFor(error);
    if (error.code === "insufficient_scope" && error.requiredScope) res.setHeader("x-radioso-required-scope", error.requiredScope);
    // Details exist so a caller can correct the call: a schema rejection names argument paths and
    // never the values at them, while a tool's own refusal states its reason, which can name a
    // workspace object this credential already reads. An authorization failure says nothing
    // beyond that it failed.
    const details = status === 401 ? undefined : error.details;
    res.status(status).json({ code: error.code, message: status === 401 ? "Unauthorized" : error.code, ...(details?.length ? { details } : {}) });
    return;
  }
  // The edge reports this 503 as an unavailable runtime and the audit record reasons it
  // `dependency_error`; both are safe summaries that name no cause. This handler is the last place
  // the error object exists, so the cause is logged once here and nowhere else.
  failure.logger.error({
    route: failure.route,
    ...(failure.invocationId ? { invocationId: failure.invocationId } : {}),
    err: asError(error),
  }, "operator_mcp_route_failed");
  res.status(503).json(UNAVAILABLE);
};

const serve = <T>(
  dependencies: Dependencies,
  route: RouteName,
  parse: (body: unknown) => T,
  call: (service: OperatorMcpApplication, input: T) => Promise<unknown>,
): RequestHandler => async (req, res) => {
  const invocationId = invocationIdOf(req.body);
  try {
    const service = dependencies.operatorMcpApplicationService;
    if (!service || !await dependencies.operatorMcpReadiness) {
      // Answers exactly as a thrown failure does, so without this line nothing distinguishes a
      // deployment that never became ready from one that broke mid-call.
      dependencies.logger.warn({ route, ...(invocationId ? { invocationId } : {}) }, "operator_mcp_route_not_ready");
      res.status(503).json(UNAVAILABLE);
      return;
    }
    res.status(200).json(await call(service, parse(req.body)));
  } catch (error) {
    handleError(error, res, { logger: dependencies.logger, route, invocationId });
  }
};

export const createOperatorMcpInternalRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  router.use(requireServiceAuthentication(dependencies));

  router.post("/admissions", serve(dependencies, "admissions", (body) => OperatorAdmissionRequestSchema.parse(body), (service, input) => service.admit(input)));
  router.post("/catalog", serve(dependencies, "catalog", (body) => OperatorCatalogRequestSchema.parse(body), (service, input) => service.list(input)));
  router.post("/invocations", serve(dependencies, "invocations", (body) => OperatorInvocationRequestSchema.parse(body), (service, input) => service.invoke(input)));
  return router;
};
