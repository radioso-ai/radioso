import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("openapi contract", () => {
  it("matches the checked-in generated yaml", () => {
    const yamlSpec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(parse(yamlSpec)).toEqual(createOpenApiDocument());
  });

  it("uses the configured session cookie name when generating the document", () => {
    const document = createOpenApiDocument({ sessionCookieName: "custom_session" });
    const sessionCookie = document.components?.securitySchemes?.sessionCookie;

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie && "name" in sessionCookie ? sessionCookie.name : undefined).toBe("custom_session");
  });

  it("does not advertise a fixed anonymous chat session cookie name", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    expect(document.components?.securitySchemes).not.toHaveProperty("anonymousSessionCookie");
    expect(paths["/api/v1/public/chat/{token}"]?.post).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}"]?.get).not.toHaveProperty("security");
    expect(paths["/api/v1/public/chat/{token}/history/{conversationId}"]?.get).not.toHaveProperty("security");
  });

  it("advertises bearer auth separately from the session cookie scheme", () => {
    const document = createOpenApiDocument();
    const schemes = document.components?.securitySchemes ?? {};
    const bearerAuth = schemes.bearerAuth;
    const sessionCookie = schemes.sessionCookie;

    expect(bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "APIKey",
    });
    expect(sessionCookie).toBeDefined();
    expect(bearerAuth).not.toEqual(sessionCookie);
    expect(document.paths?.["/api/v1/document/"]?.post?.security).toEqual([{ bearerAuth: [] }]);
  });

  it("advertises the account usage trends endpoint as a session-authenticated account report", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/account/usage-trends"]?.get;

    expect(operation).toMatchObject({
      operationId: "getAccountUsageTrends",
      tags: ["Account"],
      security: [{ sessionCookie: [] }],
    });
    expect(operation?.responses).toHaveProperty("200");
    expect(operation?.responses).toHaveProperty("400");
    expect(operation?.responses).toHaveProperty("401");
  });
});
