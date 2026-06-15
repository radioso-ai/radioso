import { describe, expect, it } from "vitest";

import { encryptField } from "../../../src/shared/infra/crypto/fieldEncryption.js";
import {
  LiveMcpConnectionLookup,
  createMcpToolServiceFactory,
} from "../../../src/modules/externalSkills/composition.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import type { McpConnectionRepository } from "../../../src/db/repositories/mcpConnectionRepository.js";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");

const repoReturning = (record: unknown): McpConnectionRepository =>
  ({ findById: async () => record }) as never;

describe("LiveMcpConnectionLookup", () => {
  it("decrypts the access token for access_token connections", async () => {
    const credentialCiphertext = encryptField("tok-123", encryptionKey);
    const lookup = new LiveMcpConnectionLookup(
      repoReturning({ id: "c1", serverUrl: "https://m", authMethod: "access_token", credentialCiphertext }),
      encryptionKey,
    );

    const result = await lookup.findById("a1", "c1");
    expect(result).toEqual({ id: "c1", serverUrl: "https://m", authMethod: "access_token", accessToken: "tok-123" });
  });

  it("returns null when the connection is missing", async () => {
    const lookup = new LiveMcpConnectionLookup(repoReturning(null), encryptionKey);
    expect(await lookup.findById("a1", "c1")).toBeNull();
  });

  it("does not resolve an access token for oauth connections (P2)", async () => {
    const lookup = new LiveMcpConnectionLookup(
      repoReturning({ id: "c1", serverUrl: "https://m", authMethod: "oauth", credentialCiphertext: null }),
      encryptionKey,
    );
    const result = await lookup.findById("a1", "c1");
    expect(result?.accessToken).toBeUndefined();
  });
});

describe("createMcpToolServiceFactory", () => {
  it("builds an MCP ToolService for token and tokenless connections", () => {
    const factory = createMcpToolServiceFactory();
    expect(
      factory.create({ id: "c1", serverUrl: "https://m", authMethod: "access_token", accessToken: "tok" }),
    ).toBeInstanceOf(SdkMcpToolService);
    expect(factory.create({ id: "c2", serverUrl: "https://m", authMethod: "oauth" })).toBeInstanceOf(SdkMcpToolService);
  });
});
