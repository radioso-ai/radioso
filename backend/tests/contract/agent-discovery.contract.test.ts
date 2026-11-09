import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

import { renderA2aAgentCard } from "../../src/modules/agentDiscovery/domain/renderA2aAgentCard.js";
import { renderMcpServerCard } from "../../src/modules/agentDiscovery/domain/renderMcpServerCard.js";
import { profileFixture } from "../unit/agentDiscovery/profileFixture.js";

/**
 * SC-005 and A2A FR-007. Both schemas are files in the repository rather than fetched, so
 * the gate runs on a machine with no network and cannot go red because someone else's site
 * is down:
 *
 * - `a2a-agent-card-v1.0-derived.schema.json` is derived by hand from `a2a.proto`, because
 *   A2A v1.0 publishes no JSON Schema for the card. It is deliberately independent of the
 *   renderer's own Zod schema: a gate built from the thing it checks passes whatever the
 *   renderer does. It enforces v1.0's rule that required arrays hold at least one element.
 * - `mcp-server-schema-2025-09-29.json` is
 *   https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json, unmodified.
 */
const loadSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/discovery-schemas/${name}`, import.meta.url)), "utf8")) as Record<string, unknown>;

// Formats carry their own registry, which is not what this gate is about: it asserts the
// documents have the published structure, field names, and required fields.
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(loadSchema("a2a-agent-card-v1.0-derived.schema.json"), "a2a");
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
  describe("A2A Agent Card against the v1.0 rules", () => {
    const A2A_CARD = "a2a#/definitions/AgentCard";

    const variants = [
      ["an agent with tools, walk-in on, and a docs URL", profileFixture()],
      ["an agent with tools, walk-in off", profileFixture({ walkInEnabled: false })],
      ["an agent with no exposed tools", profileFixture({ tools: [] })],
      ["an agent with no exposed tools and walk-in off", profileFixture({ tools: [], walkInEnabled: false })],
      ["an agent with no documentation URL", profileFixture({ documentationUrl: null })],
      [
        "an agent with no description, no tools, no docs URL, and no walk-in access",
        profileFixture({ description: null, documentationUrl: null, tools: [], walkInEnabled: false }),
      ],
    ] as const;

    it.each(variants)("accepts the card rendered for %s", (_label, profile) => {
      expect(validateWith(A2A_CARD, renderA2aAgentCard(profile))).toEqual([]);
    });

    it.each(variants)("names only schemes it declares, and only real ones, for %s", (_label, profile) => {
      const card = renderA2aAgentCard(profile);

      for (const requirement of card.securityRequirements ?? []) {
        const named = Object.keys(requirement.schemes);
        expect(named.length).toBeGreaterThan(0);
        for (const scheme of named) {
          expect(Object.keys(card.securitySchemes)).toContain(scheme);
        }
      }
    });

    // The gate is only worth its name if it fails the cards v1.0 forbids. Each case starts from
    // a rendered card and breaks one rule.
    const rendered = () => JSON.parse(JSON.stringify(renderA2aAgentCard(profileFixture()))) as Record<string, any>;

    it.each([
      ["an empty skills array", (card: Record<string, any>) => { card.skills = []; }],
      ["a skill with no tags", (card: Record<string, any>) => { card.skills[0].tags = []; }],
      ["an empty supportedInterfaces array", (card: Record<string, any>) => { card.supportedInterfaces = []; }],
      ["no default input modes", (card: Record<string, any>) => { card.defaultInputModes = []; }],
      ["no default output modes", (card: Record<string, any>) => { card.defaultOutputModes = []; }],
      ["a missing skills field", (card: Record<string, any>) => { delete card.skills; }],
      ["the v0.3 top-level url", (card: Record<string, any>) => { card.url = "https://example.test/mcp"; }],
      ["the v0.3 protocolVersion", (card: Record<string, any>) => { card.protocolVersion = "0.3.0"; }],
      ["the v0.3 preferredTransport", (card: Record<string, any>) => { card.preferredTransport = "MCP"; }],
      ["the v0.3 security list", (card: Record<string, any>) => { card.security = [{ bearer: [] }]; }],
      ["an interface with no protocolBinding", (card: Record<string, any>) => { delete card.supportedInterfaces[0].protocolBinding; }],
      ["a v0.3-shaped security scheme", (card: Record<string, any>) => { card.securitySchemes.bearer = { type: "http", scheme: "bearer" }; }],
      ["a v0.3-shaped security requirement", (card: Record<string, any>) => { card.securityRequirements = [{ bearer: [] }]; }],
    ])("rejects a card with %s", (_label, break_) => {
      const card = rendered();
      break_(card);

      expect(validateWith(A2A_CARD, card)).not.toEqual([]);
    });
  });

  it("renders an MCP server card the published server document schema accepts", () => {
    expect(validateWith("mcpServer#/definitions/ServerDetail", renderMcpServerCard(profileFixture()))).toEqual([]);
  });

  it("keeps the server card valid when the operator wrote no description", () => {
    const card = renderMcpServerCard(profileFixture({ description: null, documentationUrl: null }));

    expect(validateWith("mcpServer#/definitions/ServerDetail", card)).toEqual([]);
  });
});
