import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/contracts.js";
import { realCatalog } from "./realCatalogTestSupport.js";

/**
 * MCP advertises tool schemas in JSON Schema 2020-12, and a client that checks them against the
 * metaschema drops the whole `tools/list` when one keyword has the wrong type — so an OpenAPI-3.0
 * dialect keyword such as a boolean `exclusiveMinimum` empties the catalog for every tool at once.
 * Compiling with Ajv is the same metaschema check those clients run.
 */
const metaschema = new Ajv2020({ strict: false, validateFormats: false });

const eligible = realCatalog().filter((descriptor) => descriptor.mcpDisposition?.status === "eligible");

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
