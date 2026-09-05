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
import { OperatorMcpApplicationError } from "./mcpApplicationService.js";

type Dependencies = Pick<AppDependencies, "env" | "operatorMcpApplicationService" | "operatorMcpReadiness">;
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
  return 500;
};

const handleError = (error: unknown, res: { status(code: number): { json(value: unknown): void }; setHeader(name: string, value: string): void }): void => {
  if (error instanceof OperatorMcpApplicationError) {
    const status = statusFor(error);
    if (error.code === "insufficient_scope" && error.requiredScope) res.setHeader("x-radioso-required-scope", error.requiredScope);
    res.status(status).json({ code: error.code, message: status === 401 ? "Unauthorized" : error.code });
    return;
  }
  res.status(503).json({ code: "unavailable", message: "Operator capability is unavailable" });
};

export const createOperatorMcpInternalRoutes = (dependencies: Dependencies): Router => {
  const router = Router();
  router.use(requireServiceAuthentication(dependencies));
  const ready = async () => dependencies.operatorMcpApplicationService && await dependencies.operatorMcpReadiness;

  router.post("/admissions", async (req, res) => {
    try {
      if (!await ready()) { res.status(503).json({ code: "unavailable", message: "Operator capability is unavailable" }); return; }
      res.status(200).json(await dependencies.operatorMcpApplicationService!.admit(OperatorAdmissionRequestSchema.parse(req.body)));
    } catch (error) { handleError(error, res); }
  });
  router.post("/catalog", async (req, res) => {
    try {
      if (!await ready()) { res.status(503).json({ code: "unavailable", message: "Operator capability is unavailable" }); return; }
      res.status(200).json(await dependencies.operatorMcpApplicationService!.list(OperatorCatalogRequestSchema.parse(req.body)));
    } catch (error) { handleError(error, res); }
  });
  router.post("/invocations", async (req, res) => {
    try {
      if (!await ready()) { res.status(503).json({ code: "unavailable", message: "Operator capability is unavailable" }); return; }
      res.status(200).json(await dependencies.operatorMcpApplicationService!.invoke(OperatorInvocationRequestSchema.parse(req.body)));
    } catch (error) { handleError(error, res); }
  });
  return router;
};
