import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

import { renderA2aAgentCard } from "../../src/modules/agentDiscovery/domain/renderA2aAgentCard.js";
import { renderMcpServerCard } from "../../src/modules/agentDiscovery/domain/renderMcpServerCard.js";
import { profileFixture } from "../unit/agentDiscovery/profileFixture.js";

/**
 * SC-005. Both schemas are vendored rather than fetched, so the gate runs on a machine with
 * no network and cannot go red because someone else's site is down:
 *
 * - `a2a-agent-card-schema-v0.3.0.json` is `specification/json/a2a.json` at tag `v0.3.0` of
 *   github.com/a2aproject/A2A, unmodified.
 * - `mcp-server-schema-2025-09-29.json` is
 *   https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json, unmodified.
 */
const loadSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/discovery-schemas/${name}`, import.meta.url)), "utf8")) as Record<string, unknown>;

// Formats carry their own registry, which is not what this gate is about: it asserts the
// documents have the published structure, field names, and required fields.
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(loadSchema("a2a-agent-card-schema-v0.3.0.json"), "a2a");
ajv.addSchema(loadSchema("mcp-server-schema-2025-09-29.json"), "mcpServer");

const validator = (ref: string): ValidateFunction => {
  const validate = ajv.getSchema(ref);
  if (!validate) {
    throw new Error(`Vendored schema is missing ${ref}`);
  }
  return validate;
};

const validateWith = (ref: string, document: unknown): string[] => {
  const validate = validator(ref);
  return validate(document) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
};

describe("agent discovery documents", () => {
  it("renders an A2A Agent Card the published A2A schema accepts", () => {
    expect(validateWith("a2a#/definitions/AgentCard", renderA2aAgentCard(profileFixture()))).toEqual([]);
  });

  it("renders a valid card for an agent with no tools, no description, and no walk-in access", () => {
    const card = renderA2aAgentCard(profileFixture({
      description: null,
      documentationUrl: null,
      tools: [],
      walkInEnabled: false,
    }));

    expect(validateWith("a2a#/definitions/AgentCard", card)).toEqual([]);
  });

  it("renders an MCP server card the published server document schema accepts", () => {
    expect(validateWith("mcpServer#/definitions/ServerDetail", renderMcpServerCard(profileFixture()))).toEqual([]);
  });

  it("keeps the server card valid when the operator wrote no description", () => {
    const card = renderMcpServerCard(profileFixture({ description: null, documentationUrl: null }));

    expect(validateWith("mcpServer#/definitions/ServerDetail", card)).toEqual([]);
  });
});
