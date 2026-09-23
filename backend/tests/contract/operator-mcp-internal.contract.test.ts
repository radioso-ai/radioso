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

const harness = () => {
  const service = { admit: vi.fn(async () => ({ proof: { ok: true } })), list: vi.fn(), invoke: vi.fn() };
  const app = express();
  app.use(express.json({ verify: (req, _res, value) => { (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(value); } }));
  app.use("/api/v1/internal/operator-copilot/mcp", createOperatorMcpInternalRoutes({
    operatorMcpApplicationService: service, operatorMcpReadiness: Promise.resolve(true),
    env: { OPERATOR_MCP_INTERNAL_SECRET: secret },
  } as never));
  return { app, service };
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
