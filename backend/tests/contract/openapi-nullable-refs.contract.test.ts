import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * `Schema.nullable()` on a *registered* schema emits `allOf: [$ref, { type: [...,
 * "null"] }]`, which openapi-typescript renders as `Ref & (Record<string, never> |
 * null)`. Nothing satisfies that intersection — not `null`, not an instance of the
 * referenced schema — so an SDK consumer cannot construct the field at all. The
 * working form is `z.union([Schema, z.null()])`, which generates `Ref | null`.
 *
 * This scans the generated document rather than the builders, because the document
 * is what the SDK is generated from and therefore what a consumer is held to.
 */
const KNOWN_UNSATISFIABLE_NULLABLE_REFS = [] as const;

interface OpenApiNode {
  allOf?: Array<{ $ref?: string; type?: unknown }>;
  properties?: Record<string, OpenApiNode>;
  items?: OpenApiNode;
}

const isNullableRef = (node: OpenApiNode): boolean => {
  const [first, second] = node.allOf ?? [];
  if (!first?.$ref || !second) {
    return false;
  }
  return Array.isArray(second.type) && second.type.includes("null");
};

const collectNullableRefs = (schemas: Record<string, OpenApiNode>): string[] => {
  const found: string[] = [];
  const walk = (node: OpenApiNode | undefined, path: string): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (isNullableRef(node)) {
      found.push(path);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.${key}`);
    }
    walk(node.items, `${path}[]`);
  };
  for (const [name, schema] of Object.entries(schemas)) {
    walk(schema, name);
  }
  return found;
};

describe("OpenAPI nullable references", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
  ) as { components: { schemas: Record<string, OpenApiNode> } };

  it("adds no new field an SDK consumer cannot construct", () => {
    const found = collectNullableRefs(document.components.schemas);

    // An entry here means `Schema.nullable()` was used on a registered schema
    // instead of `z.union([Schema, z.null()])`.
    expect(found.sort()).toEqual([...KNOWN_UNSATISFIABLE_NULLABLE_REFS].sort());
  });

  it("keeps the agent bundle schemas constructible", () => {
    const found = collectNullableRefs(document.components.schemas);

    expect(found.filter((path) => path.startsWith("AgentBundle"))).toEqual([]);
  });
});
