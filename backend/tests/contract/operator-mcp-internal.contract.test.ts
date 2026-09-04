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
    service.admit.mockRejectedValueOnce(new OperatorMcpApplicationError("insufficient_scope", "operator:probe") as never);

    await request(app).post(path).set(signedHeaders(body)).send(body)
      .expect(403)
      .expect("x-radioso-required-scope", "operator:probe");
  });
});
