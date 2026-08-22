import { describe, expect, it } from "vitest";

import {
  defaultDocumentTypeCatalogRecord,
  type DocumentTypeCatalogRecord,
  type DocumentTypeCatalogWriteInput,
  type OperatorDocumentTypeDefinition,
} from "../../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import {
  DOCUMENT_TYPE_CATALOG_LIMITS,
  validateDocumentTypeCatalogWrite,
} from "../../../src/modules/documentTypes/domain/documentTypeCatalogValidation.js";

const workspaceId = "11111111-1111-1111-1111-111111111111";

const productType = (
  overrides: Partial<OperatorDocumentTypeDefinition> = {},
): OperatorDocumentTypeDefinition => ({
  key: "product",
  label: "Product",
  description: "A product detail page listing a purchasable item.",
  enabled: true,
  fields: [
    { key: "productName", label: "Product name", valueType: "string", instruction: "The product's display name." },
    { key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." },
  ],
  ...overrides,
});

const write = (
  overrides: Partial<DocumentTypeCatalogWriteInput> = {},
): DocumentTypeCatalogWriteInput => ({
  expectedRevision: "1",
  types: [productType()],
  disabledBuiltInTypeKeys: [],
  ...overrides,
});

const previousWith = (
  types: OperatorDocumentTypeDefinition[],
  overrides: Partial<DocumentTypeCatalogRecord> = {},
): DocumentTypeCatalogRecord => ({
  ...defaultDocumentTypeCatalogRecord(workspaceId),
  types,
  ...overrides,
});

describe("document type catalog validation", () => {
  const previous = defaultDocumentTypeCatalogRecord(workspaceId);

  it("accepts a well-formed operator type", () => {
    const result = validateDocumentTypeCatalogWrite({ previous, next: write() });

    expect(result.types).toHaveLength(1);
    expect(result.types[0]?.key).toBe("product");
    expect(result.types[0]?.fields.map((field) => field.key)).toEqual(["productName", "price"]);
    expect(result.retiredFields).toEqual([]);
  });

  describe("key syntax", () => {
    it("rejects a field key containing a dot", () => {
      const next = write({
        types: [
          productType({
            fields: [{ key: "product.price", label: "Price", valueType: "number", instruction: "Price." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/product\.price/);
    });

    it("rejects a field key starting with a digit", () => {
      const next = write({
        types: [
          productType({
            fields: [{ key: "1price", label: "Price", valueType: "number", instruction: "Price." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/1price/);
    });

    it("rejects a type key containing a hyphen", () => {
      const next = write({ types: [productType({ key: "product-page" })] });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/product-page/);
    });

    it("rejects a field key longer than the key limit", () => {
      const longKey = `a${"b".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxKeyChars)}`;
      const next = write({
        types: [
          productType({
            fields: [{ key: longKey, label: "Long", valueType: "string", instruction: "Long." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxKeyChars)),
      );
    });
  });

  describe("reserved keys", () => {
    it.each(["dateFrom", "dateTo"])("rejects the reserved field key %s", (key) => {
      const next = write({
        types: [productType({ fields: [{ key, label: "Date", valueType: "date", instruction: "A date." }] })],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(new RegExp(key));
    });

    it.each(["event", "article", "profile", "reference", "generic"])(
      "rejects the built-in type key %s",
      (key) => {
        const next = write({ types: [productType({ key })] });

        expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(new RegExp(key));
      },
    );

    it("rejects disabling the reserved generic type", () => {
      const next = write({ disabledBuiltInTypeKeys: ["generic"] });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/generic/);
    });

    it("rejects disabling an unknown built-in type", () => {
      const next = write({ disabledBuiltInTypeKeys: ["invoice"] });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/invoice/);
    });

    it("accepts disabling a disableable built-in type", () => {
      const result = validateDocumentTypeCatalogWrite({ previous, next: write({ disabledBuiltInTypeKeys: ["profile"] }) });

      expect(result.disabledBuiltInTypeKeys).toEqual(["profile"]);
    });
  });

  describe("workspace-wide value type consistency", () => {
    it("accepts one key declared by two types under the same value type", () => {
      const next = write({
        types: [
          productType(),
          productType({
            key: "course",
            label: "Course",
            fields: [{ key: "price", label: "Price", valueType: "number", instruction: "Course price." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).not.toThrow();
    });

    it("rejects one key declared by two types under different value types", () => {
      const next = write({
        types: [
          productType(),
          productType({
            key: "course",
            label: "Course",
            fields: [{ key: "price", label: "Price", valueType: "string", instruction: "Course price." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/price/);
    });

    it("rejects a value type that conflicts with a tombstoned identity", () => {
      const previousWithTombstone = previousWith([], {
        retiredFields: [{ key: "price", valueType: "number" }],
      });
      const next = write({
        types: [
          productType({
            fields: [{ key: "price", label: "Price", valueType: "string", instruction: "Price." }],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous: previousWithTombstone, next })).toThrowError(/price/);
    });

    it("accepts recreating a tombstoned key with its original value type", () => {
      const previousWithTombstone = previousWith([], {
        retiredFields: [{ key: "price", valueType: "number" }],
      });

      const result = validateDocumentTypeCatalogWrite({ previous: previousWithTombstone, next: write() });

      expect(result.types[0]?.fields.find((field) => field.key === "price")?.valueType).toBe("number");
    });
  });

  describe("immutability and tombstoning", () => {
    it("rejects changing the value type of an existing key", () => {
      const existing = previousWith([productType()]);
      const next = write({
        types: [
          productType({
            fields: [
              { key: "productName", label: "Product name", valueType: "string", instruction: "Name." },
              { key: "price", label: "Price", valueType: "string", instruction: "Price." },
            ],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous: existing, next })).toThrowError(/price/);
    });

    it("allows editing a label and instruction of an existing key", () => {
      const existing = previousWith([productType()]);
      const next = write({
        types: [
          productType({
            fields: [
              { key: "productName", label: "Product name", valueType: "string", instruction: "Name." },
              { key: "price", label: "Retail price", valueType: "number", instruction: "Retail price in euros." },
            ],
          }),
        ],
      });

      const result = validateDocumentTypeCatalogWrite({ previous: existing, next });

      expect(result.types[0]?.fields[1]).toMatchObject({ label: "Retail price", instruction: "Retail price in euros." });
      expect(result.retiredFields).toEqual([]);
    });

    it("tombstones a deleted field with its value type", () => {
      const existing = previousWith([productType()]);
      const next = write({
        types: [
          productType({
            fields: [{ key: "productName", label: "Product name", valueType: "string", instruction: "Name." }],
          }),
        ],
      });

      const result = validateDocumentTypeCatalogWrite({ previous: existing, next });

      expect(result.retiredFields).toEqual([{ key: "price", valueType: "number" }]);
    });

    it("tombstones every field of a deleted type", () => {
      const existing = previousWith([productType()]);
      const next = write({ types: [] });

      const result = validateDocumentTypeCatalogWrite({ previous: existing, next });

      expect(result.retiredFields).toEqual([
        { key: "productName", valueType: "string" },
        { key: "price", valueType: "number" },
      ]);
    });

    it("keeps a tombstone after the key is recreated so the identity is permanent", () => {
      const existing = previousWith([], { retiredFields: [{ key: "price", valueType: "number" }] });

      const result = validateDocumentTypeCatalogWrite({ previous: existing, next: write() });

      expect(result.retiredFields).toEqual([{ key: "price", valueType: "number" }]);
    });

    it("does not tombstone a key that is still declared by another type", () => {
      const existing = previousWith([
        productType(),
        productType({
          key: "course",
          label: "Course",
          fields: [{ key: "price", label: "Price", valueType: "number", instruction: "Course price." }],
        }),
      ]);
      const next = write({
        types: [
          productType({
            key: "course",
            label: "Course",
            fields: [{ key: "price", label: "Price", valueType: "number", instruction: "Course price." }],
          }),
        ],
      });

      const result = validateDocumentTypeCatalogWrite({ previous: existing, next });

      expect(result.retiredFields).toEqual([{ key: "productName", valueType: "string" }]);
    });
  });

  describe("bounds", () => {
    it("rejects more operator types than the limit", () => {
      const types = Array.from({ length: DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes + 1 }, (_unused, index) =>
        productType({ key: `product${index}`, fields: [] }),
      );

      expect(() => validateDocumentTypeCatalogWrite({ previous, next: write({ types }) })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes)),
      );
    });

    it("rejects more fields per type than the limit", () => {
      const fields = Array.from({ length: DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType + 1 }, (_unused, index) => ({
        key: `field${index}`,
        label: `Field ${index}`,
        valueType: "string" as const,
        instruction: "A field.",
      }));

      expect(() =>
        validateDocumentTypeCatalogWrite({ previous, next: write({ types: [productType({ fields })] }) }),
      ).toThrowError(new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType)));
    });

    it("rejects a description longer than the limit", () => {
      const next = write({
        types: [productType({ description: "d".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars + 1) })],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars)),
      );
    });

    it("rejects an instruction longer than the limit", () => {
      const next = write({
        types: [
          productType({
            fields: [
              {
                key: "price",
                label: "Price",
                valueType: "number",
                instruction: "i".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars + 1),
              },
            ],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars)),
      );
    });

    it("rejects a label longer than the limit", () => {
      const next = write({
        types: [productType({ label: "l".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars + 1) })],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars)),
      );
    });

    it("rejects a catalog whose rendered prompt section exceeds the budget", () => {
      const fields = Array.from({ length: DOCUMENT_TYPE_CATALOG_LIMITS.maxFieldsPerType }, (_unused, index) => ({
        key: `field${index}`,
        label: "l".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxLabelChars),
        valueType: "string" as const,
        instruction: "i".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxInstructionChars),
      }));
      const types = Array.from({ length: DOCUMENT_TYPE_CATALOG_LIMITS.maxOperatorTypes }, (_unused, index) =>
        productType({
          key: `product${index}`,
          description: "d".repeat(DOCUMENT_TYPE_CATALOG_LIMITS.maxDescriptionChars),
          fields,
        }),
      );

      expect(() => validateDocumentTypeCatalogWrite({ previous, next: write({ types }) })).toThrowError(
        new RegExp(String(DOCUMENT_TYPE_CATALOG_LIMITS.maxRenderedPromptChars)),
      );
    });
  });

  describe("structural rejections", () => {
    it("rejects duplicate type keys", () => {
      const next = write({ types: [productType(), productType()] });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/product/);
    });

    it("rejects duplicate field keys inside one type", () => {
      const next = write({
        types: [
          productType({
            fields: [
              { key: "price", label: "Price", valueType: "number", instruction: "Price." },
              { key: "price", label: "Price again", valueType: "number", instruction: "Price." },
            ],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/price/);
    });

    it("rejects an unsupported value type", () => {
      const next = write({
        types: [
          productType({
            fields: [
              { key: "price", label: "Price", valueType: "money" as never, instruction: "Price." },
            ],
          }),
        ],
      });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/price/);
    });

    it("rejects a blank label", () => {
      const next = write({ types: [productType({ label: "   " })] });

      expect(() => validateDocumentTypeCatalogWrite({ previous, next })).toThrowError(/label/i);
    });
  });
});
