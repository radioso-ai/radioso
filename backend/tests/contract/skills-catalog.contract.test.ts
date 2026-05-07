import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("skills catalog contract", () => {
  it("returns read-only skill catalog metadata", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "skills-list@example.com");

    const response = await request(app)
      .get("/api/v1/skills")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "retrieval.answer",
        displayName: "Retrieval answer",
        owner: "retrieval",
        executionClass: "interactive",
        availability: { state: "available" },
        supportedCallers: ["retrieval_api", "sdk", "mcp"],
        requiredCapabilities: ["retrieval.answer"],
        contractReferences: [
          expect.objectContaining({
            kind: "http",
            method: "POST",
            path: "/api/v1/retrieval/answer",
          }),
          expect.objectContaining({
            kind: "mcp_tool",
            path: "answer_grounded",
          }),
        ],
        diagnostics: expect.objectContaining({
          defined: true,
          shapeAware: true,
          strategyAware: true,
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: "context_selection",
            kind: "context_selection",
          }),
        ]),
        shapes: expect.arrayContaining([
          expect.objectContaining({
            name: "definition_lookup",
          }),
        ]),
      }),
    ]));
    expect(response.body.skills).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        contractReferences: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("/skills/") }),
        ]),
      }),
    ]));
  });

  it("returns one skill detail by stable name", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "skills-detail@example.com");

    const response = await request(app)
      .get("/api/v1/skills/retrieval.answer")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: "retrieval.answer",
      owner: "retrieval",
      requiredCapabilities: ["retrieval.answer"],
      diagnostics: {
        defined: true,
        shapeAware: true,
        strategyAware: true,
      },
    });
  });

  it("returns a stable not-found shape for unknown skills", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "skills-unknown@example.com");

    const response = await request(app)
      .get("/api/v1/skills/not.real")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "skill_not_found",
        message: "Skill not found",
      },
    });
  });

  it("documents skills catalog routes in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/skills:");
    expect(spec).toContain("/api/v1/skills/{skillName}:");
    expect(spec).toContain("SkillCatalogEntry:");
    expect(spec).toContain("SkillDiagnosticDefinition:");
  });
});
