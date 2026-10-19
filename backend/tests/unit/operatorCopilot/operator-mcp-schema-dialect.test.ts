import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OperatorCatalogResponseSchema, OperatorToolDescriptorSchema } from "@radioso/operator-mcp-contract";

import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import type { CopilotMcpDisposition, CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/contracts.js";
import { realCatalog } from "./realCatalogTestSupport.js";

type EligibleToolDescriptor = CopilotToolDescriptor & {
  mcpDisposition: Extract<CopilotMcpDisposition, { status: "eligible" }>;
};

/**
 * MCP advertises tool schemas in JSON Schema 2020-12, and a client that checks them against the
 * metaschema drops the whole `tools/list` when one keyword has the wrong type — so an OpenAPI-3.0
 * dialect keyword such as a boolean `exclusiveMinimum` empties the catalog for every tool at once.
 * Compiling with Ajv is the same metaschema check those clients run.
 */
const metaschema = new Ajv2020({ strict: false, validateFormats: false });

const eligible = realCatalog().filter(
  (descriptor): descriptor is EligibleToolDescriptor => descriptor.mcpDisposition?.status === "eligible",
);

describe("operator MCP tool schema dialect", () => {
  it("has eligible descriptors to check", () => {
    expect(eligible.length).toBeGreaterThan(0);
  });

  it.each(eligible.map((descriptor) => [descriptor.name, descriptor] as const))(
    "advertises %s in the dialect MCP clients validate against",
    (_name, descriptor) => {
      const { inputSchema, outputSchema } = operatorMcpToolSchemas(descriptor);
      for (const schema of [inputSchema, outputSchema]) {
        expect(schema.$schema).toBeUndefined();
        expect(() => metaschema.compile(schema)).not.toThrow();
      }
    },
  );
});

/**
 * The MCP edge parses the backend's catalog against the shared contract before it answers
 * `tools/list`, so one descriptor over a contract bound (a description past its length cap, say)
 * fails the parse and every client gets no tools at all.
 */
describe("every copilot tool description", () => {
  // Ray serves the same descriptors over MCP, whose edge refuses a whole catalog with one
  // description past its bound; held to that bound here for every tool, eligible or not yet.
  it.each(realCatalog().map((descriptor) => [descriptor.name, descriptor.description] as const))(
    "fits the edge's description bound: %s",
    (_name, description) => {
      expect(OperatorToolDescriptorSchema.shape.description.safeParse(description).error?.issues).toBeUndefined();
    },
  );
});

describe("operator MCP catalog contract", () => {
  const advertised = eligible.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    ...operatorMcpToolSchemas(descriptor),
    shape: descriptor.shape,
    requiredScope: descriptor.mcpDisposition.scope,
  }));

  it.each(advertised.map((tool) => [tool.name, tool] as const))(
    "advertises %s within the edge's descriptor contract",
    (_name, tool) => {
      expect(OperatorToolDescriptorSchema.safeParse(tool).error?.issues).toBeUndefined();
    },
  );

  it("advertises the whole catalog as one response the edge accepts", () => {
    expect(OperatorCatalogResponseSchema.safeParse({ tools: advertised }).success).toBe(true);
  });
});

describe("operator MCP tool schema assembly", () => {
  const descriptor = (inputSchema: z.ZodType<unknown>) =>
    ({ name: "tuple_tool", inputSchema, outputSchema: z.object({ ok: z.boolean() }) } as unknown as CopilotToolDescriptor);

  it("refuses a schema whose keywords only a draft-7 client reads", () => {
    // A tuple serializes to draft 7's array-form `items`, which 2020-12 spells `prefixItems`;
    // catching it at assembly keeps it a boot failure rather than an empty catalog in production.
    expect(() => operatorMcpToolSchemas(descriptor(z.object({ pair: z.tuple([z.string(), z.number()]) }))))
      .toThrow(/tuple_tool/);
  });

  it("admits an array schema that both dialects read the same way", () => {
    const { inputSchema } = operatorMcpToolSchemas(descriptor(z.object({ names: z.array(z.string()) })));
    expect(() => metaschema.compile(inputSchema)).not.toThrow();
  });
});
