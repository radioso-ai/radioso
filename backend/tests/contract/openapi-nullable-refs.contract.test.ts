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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableRef = (node: unknown): boolean => {
  if (!isRecord(node) || !Array.isArray(node.allOf)) {
    return false;
  }
  const [first, second] = node.allOf;
  return isRecord(first)
    && typeof first.$ref === "string"
    && isRecord(second)
    && Array.isArray(second.type)
    && second.type.includes("null");
};

const collectNullableRefs = (document: unknown): string[] => {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (isNullableRef(node)) {
      found.push(path);
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(document, "");
  return found;
};

describe("OpenAPI nullable references", () => {
  const document = JSON.parse(
    readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
  ) as unknown;

  it("adds no new field an SDK consumer cannot construct", () => {
    const found = collectNullableRefs(document);

    // An entry here means `Schema.nullable()` was used on a registered schema
    // instead of `z.union([Schema, z.null()])`.
    expect(found.sort()).toEqual([...KNOWN_UNSATISFIABLE_NULLABLE_REFS].sort());
  });

  it("finds nullable references beneath additional properties", () => {
    const found = collectNullableRefs({
      nullableMap: {
        additionalProperties: {
          allOf: [
            { $ref: "#/components/schemas/RegisteredValue" },
            { type: ["string", "null"] },
          ],
        },
      },
    });

    expect(found).toEqual(["nullableMap.additionalProperties"]);
  });

  it("keeps the agent bundle schemas constructible", () => {
    const found = collectNullableRefs(document);

    expect(found.filter((path) => path.startsWith("components.schemas.AgentBundle"))).toEqual([]);
  });
});
