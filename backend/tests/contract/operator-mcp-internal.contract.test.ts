import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOperatorMcpRequestSignature, OPERATOR_SERVICE_AUTH_HEADERS, sha256Digest } from "@radioso/operator-mcp-contract";

import { createOperatorMcpInternalRoutes } from "../../src/modules/operatorCopilot/mcpRoutes.js";
import { OperatorMcpApplicationError } from "../../src/modules/operatorCopilot/mcpApplicationService.js";

const secret = "internal-secret-at-least-thirty-two-bytes";
const path = "/api/v1/internal/operator-copilot/mcp/admissions";
const body = {
  accessToken: "access", invocationId: "00000000-0000-4000-8000-000000000001", method: "tools/list",
  resource: "https://mcp.example/operator/mcp", timestamp: "1788480000", nonce: "edge-nonce", bodyDigest: sha256Digest("mcp-body"),
};

const harness = ({ ready = true }: { ready?: boolean } = {}) => {
  const service = { admit: vi.fn(async () => ({ proof: { ok: true } })), list: vi.fn(), invoke: vi.fn() };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const app = express();
  app.use(express.json({ verify: (req, _res, value) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(value); } }));
  app.use("/api/v1/internal/operator-copilot/mcp", createOperatorMcpInternalRoutes({
    operatorMcpApplicationService: service, operatorMcpReadiness: Promise.resolve(ready),
    env: { OPERATOR_MCP_INTERNAL_SECRET: secret }, logger,
  } as never));
  return { app, service, logger };
};

const signedHeaders = (payload: unknown, override: Partial<Record<string, string>> = {}) => {
  const serialized = JSON.stringify(payload); const bodyDigest = sha256Digest(serialized);
  const timestamp = Math.floor(Date.now() / 1000).toString(); const nonce = "signed-request-nonce";
  return {
    [OPERATOR_SERVICE_AUTH_HEADERS.service]: "radioso-mcp-operator",
    [OPERATOR_SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [OPERATOR_SERVICE_AUTH_HEADERS.nonce]: nonce,
    [OPERATOR_SERVICE_AUTH_HEADERS.bodyDigest]: bodyDigest,
    [OPERATOR_SERVICE_AUTH_HEADERS.signature]: createOperatorMcpRequestSignature({ secret, service: "radioso-mcp-operator", method: "POST", path, timestamp, nonce, bodyDigest }),
    ...override,
  };
};

describe("operator MCP internal service contract", () => {
  it("rejects unsigned, wrong-service, and body-tampered admission calls", async () => {
    const { app } = harness();
    await request(app).post(path).send(body).expect(401);
    await request(app).post(path).set(signedHeaders(body, { [OPERATOR_SERVICE_AUTH_HEADERS.service]: "wrong" })).send(body).expect(401);
    await request(app).post(path).set(signedHeaders(body)).send({ ...body, nonce: "tampered" }).expect(401);
  });

  it("admits an exactly signed request without forwarding service auth material", async () => {
    const { app, service } = harness();
    await request(app).post(path).set(signedHeaders(body)).send(body).expect(200);
    expect(service.admit).toHaveBeenCalledWith(body);
  });

  it("returns the exact missing descriptor scope to the protected resource", async () => {
    const { app, service } = harness();
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("insufficient_scope", "operator:probe"));

    await request(app).post(path).set(signedHeaders(body)).send(body)
      .expect(403)
      .expect("x-radioso-required-scope", "operator:probe");
  });

  it("reports bounded-result failures as runtime errors rather than invalid credentials", async () => {
    const { app, service } = harness();
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("result_too_large"));

    const response = await request(app).post(path).set(signedHeaders(body)).send(body).expect(500);

    expect(response.body).toEqual({ code: "result_too_large", message: "result_too_large" });
  });

  it("names the cause of an unexpected failure once, in a log the bare 503 cannot carry", async () => {
    const { app, service, logger } = harness();
    service.admit.mockRejectedValueOnce(new Error("proposal store connection reset"));

    const response = await request(app).post(path).set(signedHeaders(body)).send(body).expect(503);

    expect(response.body).toEqual({ code: "unavailable", message: "Operator capability is unavailable" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("operator_mcp_route_failed");
    expect(fields.route).toBe("admissions");
    expect(fields.invocationId).toBe(body.invocationId);
    expect((fields.err as Error).message).toBe("proposal store connection reset");
  });

  it("logs a thrown non-error as an error so the stack survives", async () => {
    const { app, service, logger } = harness();
    service.admit.mockRejectedValueOnce("catalog build rejected");

    await request(app).post(path).set(signedHeaders(body)).send(body).expect(503);

    const [fields] = logger.error.mock.calls[0] as [Record<string, unknown>];
    expect(fields.err).toBeInstanceOf(Error);
    expect((fields.err as Error).message).toBe("catalog build rejected");
  });

  it("keeps a refusal the caller can act on out of the error log", async () => {
    const { app, service, logger } = harness();
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("insufficient_scope", "operator:probe"));

    await request(app).post(path).set(signedHeaders(body)).send(body).expect(403);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it("separates a runtime that never became ready from one that threw", async () => {
    const { app, service, logger } = harness({ ready: false });

    const response = await request(app).post(path).set(signedHeaders(body)).send(body).expect(503);

    expect(response.body).toEqual({ code: "unavailable", message: "Operator capability is unavailable" });
    expect(service.admit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls).toEqual([[{ route: "admissions", invocationId: body.invocationId }, "operator_mcp_route_not_ready"]]);
  });

  it("returns an actionable configuration response instead of an unavailable runtime error", async () => {
    const { app, service } = harness();
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("missing_configuration"));

    const response = await request(app).post(path).set(signedHeaders(body)).send(body).expect(409);

    expect(response.body).toEqual({ code: "missing_configuration", message: "missing_configuration" });
  });

  it("carries rejected argument paths on a refusal, and says nothing beyond the failure on an authorization error", async () => {
    const { app, service } = harness();
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("invalid_arguments", undefined, ["kind: invalid_enum_value"]));

    const rejected = await request(app).post(path).set(signedHeaders(body)).send(body).expect(400);
    expect(rejected.body).toEqual({ code: "invalid_arguments", message: "invalid_arguments", details: ["kind: invalid_enum_value"] });

    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("invalid_proof", undefined, ["kind: invalid_enum_value"]));
    const unauthorized = await request(app).post(path).set(signedHeaders(body)).send(body).expect(401);
    expect(unauthorized.body).toEqual({ code: "invalid_proof", message: "Unauthorized" });
  });
});
