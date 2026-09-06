import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OperatorClientFixtureSchema } from "./fixtures/operator-mcp-clients/schema.js";

const fixtures = ["codex-cli", "claude-code", "chatgpt-developer-mode"] as const;

describe("operator client fixture foundation", () => {
  it("records an explicit, no-secret launch contract for every named client surface", async () => {
    for (const name of fixtures) {
      const fixture = OperatorClientFixtureSchema.parse(JSON.parse(await readFile(new URL(`./fixtures/operator-mcp-clients/${name}.json`, import.meta.url), "utf8")));
      expect(fixture.verified).toBe(false);
      expect(fixture.availability).toBe("unavailable");
    }
  });

  it("rejects nested credential-like values and incomplete verified evidence", () => {
    expect(() => OperatorClientFixtureSchema.parse({
      availability: "unavailable", clientIdentification: "client-id-metadata-document", clientSurface: "test",
      displayName: "Test", failureRecovery: "Use browser handoff.", handoff: "remote-http-oauth-discovery",
      evidence: { nested: "Bearer abc123" }, resourceInsertion: "explicit-canonical-resource", redirectMechanism: "loopback",
      supportedBuild: "test", verified: false,
    })).toThrow(/unrecognized|artifact/i);
    expect(() => OperatorClientFixtureSchema.parse({
      availability: "available", clientIdentification: "client-id-metadata-document", clientSurface: "test",
      displayName: "Test", failureRecovery: "Use browser handoff.", handoff: "remote-http-oauth-discovery",
      resourceInsertion: "explicit-canonical-resource", redirectMechanism: "loopback", supportedBuild: "test", verified: true,
    })).toThrow(/evidence|operations/i);
    expect(() => OperatorClientFixtureSchema.parse({
      availability: "available", clientIdentification: "client-id-metadata-document", clientSurface: "test",
      displayName: "Test", exactBuildEvidenceRef: "evidence/test.json", failureRecovery: "Use browser handoff.", handoff: "remote-http-oauth-discovery",
      operations: ["discovery"], resourceInsertion: "explicit-canonical-resource", redirectMechanism: "loopback", supportedBuild: "test", verified: true,
    })).toThrow(/operations/i);
  });
});
