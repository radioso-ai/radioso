import { describe, expect, it } from "vitest";

import {
  EncryptionNotConfiguredError,
  McpConnectionService,
} from "../../../src/modules/externalSkills/services/mcpConnectionService.js";
import {
  InMemoryMcpConnectionRepository,
  createMockToolServiceFactory,
} from "../../support/inMemoryExternalSkills.js";

const encryptionKey = Buffer.alloc(32, 3).toString("base64");
const baseInput = {
  displayName: "Slack",
  serverUrl: "https://mcp.example.com",
  authMethod: "access_token" as const,
  accessToken: "tok",
};

describe("McpConnectionService (unit)", () => {
  it("rejects a connection whose URL fails the SSRF guard", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      assertPublicUrl: (url) => {
        if (url.includes("127.0.0.1") || url.includes(".internal")) {
          throw new Error("non-public host");
        }
      },
    });

    await expect(service.create("agent-1", { ...baseInput, serverUrl: "https://127.0.0.1:8443" })).rejects.toThrow();
    // A public host passes the guard.
    await expect(service.create("agent-1", baseInput)).resolves.toMatchObject({ status: "authorized" });
  });

  it("fails with a 503 AppError when encryption is not configured", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      // no encryptionKey
    });

    await expect(service.create("agent-1", baseInput)).rejects.toBeInstanceOf(EncryptionNotConfiguredError);
    await expect(service.create("agent-1", baseInput)).rejects.toMatchObject({ statusCode: 503 });
  });
});
