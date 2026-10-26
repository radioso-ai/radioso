import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { copilotCapabilityProvenance } from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import { createOpenApiDocument } from "../../../src/app/http/openapi/openApiDocument.js";
import { realCatalog } from "./realCatalogTestSupport.js";
import { fieldExclusions, maxDeferredFieldParityExclusions } from "./fieldParity.js";

/**
 * The field-parity gate between an OpenAPI request body and the operator-copilot tool that stands
 * in for it. `capabilityProvenance.ts`'s `backingOperationIds` says which REST operations a tool
 * represents; `catalogCoverage.ts` (the companion operation-level gate) says which operation each
 * tool covers. Neither compares the two schemas' *fields* — a tool could drop a body field on
 * either side of a change and nothing would notice. This test does that comparison, at the
 * top level of each schema only: a body field carried one level deeper in the tool (or vice
 * versa) is still a drop-out from this literal check and needs a recorded, specific reason in
 * `fieldExclusions`, the same as a field with no tool support at all.
 */

type OpenApiDocument = ReturnType<typeof createOpenApiDocument>;
type SchemaObject = Record<string, unknown>;

const resolveRef = (doc: OpenApiDocument, ref: string): SchemaObject => {
  const parts = ref.replace(/^#\//, "").split("/");
  let node: unknown = doc;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) throw new Error(`Cannot resolve $ref segment "${part}" of "${ref}"`);
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "object" || node === null) throw new Error(`$ref "${ref}" did not resolve to an object`);
  return node as SchemaObject;
};

/** Top-level property names a request body schema declares, resolving $ref/allOf/oneOf/anyOf. */
const collectBodyPropertyNames = (doc: OpenApiDocument, schema: unknown, seen: Set<unknown> = new Set()): Set<string> => {
  if (typeof schema !== "object" || schema === null || seen.has(schema)) return new Set();
  seen.add(schema);
  const node = schema as SchemaObject;
  if (typeof node.$ref === "string") return collectBodyPropertyNames(doc, resolveRef(doc, node.$ref), seen);
  const out = new Set<string>();
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf) for (const key of collectBodyPropertyNames(doc, sub, seen)) out.add(key);
  }
  const union = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : null;
  if (union) {
    for (const sub of union) for (const key of collectBodyPropertyNames(doc, sub, seen)) out.add(key);
  }
  if (node.properties && typeof node.properties === "object") {
    for (const key of Object.keys(node.properties)) out.add(key);
  }
  return out;
};

/**
 * Top-level keys of a tool's Zod input schema, or `null` when the schema is not one of the shapes
 * this gate knows how to introspect (a descriptor is expected to fail loudly in that case rather
 * than being skipped — see the "every production descriptor" test below).
 */
const zodTopLevelKeys = (schema: z.core.$ZodType): ReadonlyArray<string> | null => {
  let def = (schema as z.core.$ZodTypes)._zod.def;
  for (;;) {
    if (def.type === "pipe") {
      // `.transform()` pipes the shaped schema in; `z.preprocess()` pipes it out.
      const inner = (def.in as z.core.$ZodTypes)._zod.def.type === "transform" ? def.out : def.in;
      def = (inner as z.core.$ZodTypes)._zod.def;
      continue;
    }
    if (def.type === "optional" || def.type === "default" || def.type === "prefault") {
      def = (def.innerType as z.core.$ZodTypes)._zod.def;
      continue;
    }
    break;
  }
  if (def.type === "object") return Object.keys(def.shape);
  if (def.type === "union") {
    const out = new Set<string>();
    for (const option of def.options) {
      const keys = zodTopLevelKeys(option);
      if (!keys) return null;
      for (const key of keys) out.add(key);
    }
    return [...out];
  }
  return null;
};

const operationsWithBodies = (doc: OpenApiDocument) => {
  const byId = new Map<string, { readonly method: string; readonly path: string; readonly bodySchema: unknown }>();
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods as Record<string, unknown>)) {
      if (!operation || typeof operation !== "object") continue;
      const op = operation as { operationId?: string; requestBody?: { content?: Record<string, { schema?: unknown }> } };
      if (!op.operationId) continue;
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      byId.set(op.operationId, { method, path, bodySchema });
    }
  }
  return byId;
};

describe("operator copilot field parity", () => {
  const doc = createOpenApiDocument();
  const operations = operationsWithBodies(doc);
  const catalog = realCatalog();
  const catalogByName = new Map(catalog.map((descriptor) => [descriptor.name, descriptor]));

  it("keeps every recorded exclusion live and every drift recorded", () => {
    const unrecordedGaps: string[] = [];
    const liveExclusionKeys = new Set<string>();

    for (const [toolName, provenance] of Object.entries(copilotCapabilityProvenance)) {
      const backingOperationIds = provenance.backingOperationIds ?? [];
      if (backingOperationIds.length === 0) continue;

      // A backing operation the OpenAPI document does not know cannot be compared, and skipping it
      // would let the gate pass vacuously for that tool; fail here even though provenance
      // validation elsewhere also rejects unknown operation ids.
      for (const operationId of backingOperationIds) {
        if (!operations.has(operationId)) {
          throw new Error(`Tool "${toolName}" cites backing operation "${operationId}", which is not in the OpenAPI document.`);
        }
      }
      const bodies = backingOperationIds
        .map((operationId) => ({ operationId, entry: operations.get(operationId) }))
        .filter((candidate): candidate is { operationId: string; entry: { method: string; path: string; bodySchema: unknown } } =>
          candidate.entry !== undefined && candidate.entry.bodySchema !== undefined);
      if (bodies.length === 0) continue;

      const descriptor = catalogByName.get(toolName);
      if (!descriptor) throw new Error(`No assembled descriptor for copilot tool "${toolName}", which backingOperationIds names as backing ${backingOperationIds.join(", ")}.`);

      const toolKeys = zodTopLevelKeys(descriptor.inputSchema);
      if (!toolKeys) throw new Error(`Tool "${toolName}"'s inputSchema is not an introspectable ZodObject/union; the field-parity gate cannot compare its fields against ${backingOperationIds.join(", ")}.`);

      for (const { operationId, entry } of bodies) {
        const bodyFieldNames = collectBodyPropertyNames(doc, entry.bodySchema);
        for (const fieldName of bodyFieldNames) {
          if (toolKeys.includes(fieldName)) continue;
          const exclusion = fieldExclusions[toolName]?.[fieldName];
          liveExclusionKeys.add(`${toolName}.${fieldName}`);
          if (!exclusion || exclusion.reason.trim().length === 0) {
            unrecordedGaps.push(`${toolName} (tool) <- ${operationId} (operation): field "${fieldName}" is on the request body but absent from the tool's input, with no recorded fieldExclusions entry.`);
          }
        }
      }
    }

    expect(unrecordedGaps).toEqual([]);

    const staleExclusions = Object.entries(fieldExclusions)
      .flatMap(([toolName, byField]) => Object.keys(byField).map((fieldName) => `${toolName}.${fieldName}`))
      .filter((key) => !liveExclusionKeys.has(key));
    expect(staleExclusions).toEqual([]);
  });

  it("requires a non-empty, specific reason for every recorded exclusion", () => {
    for (const [toolName, byField] of Object.entries(fieldExclusions)) {
      for (const [fieldName, exclusion] of Object.entries(byField)) {
        expect(exclusion.reason.trim().length, `${toolName}.${fieldName}`).toBeGreaterThan(0);
        expect(["deferred", "permanent"]).toContain(exclusion.disposition);
      }
    }
  });

  it("does not expand the deferred field-parity backlog", () => {
    const deferredCount = Object.values(fieldExclusions)
      .flatMap((byField) => Object.values(byField))
      .filter((exclusion) => exclusion.disposition === "deferred")
      .length;

    expect(deferredCount).toBeLessThanOrEqual(maxDeferredFieldParityExclusions);
  });
});
