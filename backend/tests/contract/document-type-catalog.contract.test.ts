import { readFileSync } from "node:fs";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const productType = {
  key: "product",
  label: "Product",
  description: "A product detail page listing a purchasable item.",
  enabled: true,
  fields: [
    { key: "productName", label: "Product name", valueType: "string", instruction: "The product's display name." },
    { key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." },
  ],
};

describe("document type catalog contract", () => {
  it("returns the built-in catalog before an operator defines anything", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-default@example.com");

    const response = await request(app)
      .get("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body.revision).toBe("1");
    expect(response.body.retiredFields).toEqual([]);
    expect(response.body.types.map((type: { key: string }) => type.key)).toEqual([
      "event",
      "article",
      "profile",
      "reference",
      "generic",
    ]);
    expect(response.body.types.every((type: { origin: string }) => type.origin === "built_in")).toBe(true);
    expect(response.body.types.find((type: { key: string }) => type.key === "generic")).toMatchObject({
      disableable: false,
      enabled: true,
    });
    expect(response.body.types.find((type: { key: string }) => type.key === "event")?.fields).toEqual([
      expect.objectContaining({ key: "dateFrom", valueType: "date" }),
      expect.objectContaining({ key: "dateTo", valueType: "date" }),
    ]);
    expect(response.body.referencedFieldKeys).toEqual([]);
  });

  it("reports which field keys agent metadata rules reference so a delete can warn", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-references@example.com");
    const headers = adminSessionHeaders(session);

    const agentList = await request(app).get("/api/v1/agents").set(headers);
    const agentId = agentList.body.agents[0].id as string;

    const created = await request(app)
      .post(`/api/v1/agents/${agentId}/skills`)
      .set(headers)
      .send({
        name: "search_products",
        capability: "retrieve",
        target: { kind: "source_scope", id: null },
        config: {
          metadataRules: [
            {
              id: "rule-1",
              field: "price",
              valueType: "number",
              operator: "lt",
              value: "50",
              conditions: [
                { id: "condition-1", field: "price", valueType: "number", operator: "lt", value: "50" },
                { id: "condition-2", field: "category", valueType: "string", operator: "equals", value: "shoes" },
              ],
              effect: "filter",
              enabled: true,
              triggerMode: "always_on",
            },
          ],
        },
        invocationMode: "agent_selectable",
        enabled: true,
      });
    expect(created.status).toBe(201);

    const response = await request(app)
      .get("/api/v1/settings/document-types")
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.referencedFieldKeys).toEqual(["category", "price"]);
  });

  it("round-trips an operator-defined type and bumps the revision", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-roundtrip@example.com");

    const saved = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({ expectedRevision: "1", types: [productType], disabledBuiltInTypeKeys: [] });

    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe("2");

    const reread = await request(app)
      .get("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session));

    expect(reread.status).toBe(200);
    const product = reread.body.types.find((type: { key: string }) => type.key === "product");
    expect(product).toMatchObject({ origin: "operator", payload: "fields", disableable: true });
    expect(product.fields.map((field: { key: string }) => field.key)).toEqual(["productName", "price"]);
    // Built-in entries always come first so the operator list reads as an extension.
    expect(reread.body.types[0].key).toBe("event");
  });

  it("rejects a save built on a stale revision with the current one", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-conflict@example.com");

    await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({ expectedRevision: "1", types: [productType], disabledBuiltInTypeKeys: [] });

    const stale = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({ expectedRevision: "1", types: [], disabledBuiltInTypeKeys: [] });

    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain("2");
  });

  it("rejects a field key that metadata rules could never match", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-key-syntax@example.com");

    const response = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({
        expectedRevision: "1",
        types: [
          {
            ...productType,
            fields: [{ key: "product.price", label: "Price", valueType: "number", instruction: "Price." }],
          },
        ],
        disabledBuiltInTypeKeys: [],
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("product.price");
  });

  it("rejects a reserved field key", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-reserved-field@example.com");

    const response = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({
        expectedRevision: "1",
        types: [
          {
            ...productType,
            fields: [{ key: "dateFrom", label: "Start", valueType: "date", instruction: "Start." }],
          },
        ],
        disabledBuiltInTypeKeys: [],
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("dateFrom");
  });

  it("refuses to disable the reserved generic fallback", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-generic@example.com");

    const response = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({ expectedRevision: "1", types: [], disabledBuiltInTypeKeys: ["generic"] });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("generic");
  });

  it("retires a deleted field so it can never come back under another value type", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "catalog-tombstone@example.com");

    await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({ expectedRevision: "1", types: [productType], disabledBuiltInTypeKeys: [] });

    const deleted = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({
        expectedRevision: "2",
        types: [{ ...productType, fields: [productType.fields[0]] }],
        disabledBuiltInTypeKeys: [],
      });

    expect(deleted.status).toBe(200);
    expect(deleted.body.retiredFields).toEqual([{ key: "price", valueType: "number" }]);

    const retyped = await request(app)
      .put("/api/v1/settings/document-types")
      .set(adminSessionHeaders(session))
      .send({
        expectedRevision: "3",
        types: [
          {
            ...productType,
            fields: [{ key: "price", label: "Price", valueType: "string", instruction: "Price." }],
          },
        ],
        disabledBuiltInTypeKeys: [],
      });

    expect(retyped.status).toBe(400);
    expect(JSON.stringify(retyped.body)).toContain("price");
  });

  it("requires an authenticated workspace session", async () => {
    const { app } = createTestApp();

    expect((await request(app).get("/api/v1/settings/document-types")).status).toBe(401);
    expect(
      (await request(app).put("/api/v1/settings/document-types").send({ expectedRevision: "1" })).status,
    ).toBe(401);
  });

  it("documents the catalog resource in the generated schema", () => {
    const spec = readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8");

    expect(spec).toContain("/api/v1/settings/document-types:");
    expect(spec).toContain("DocumentTypeCatalog:");
    expect(spec).toContain("DocumentTypeDefinition:");
    expect(spec).toContain("RetiredDocumentTypeField:");
    expect(spec).toContain("referencedFieldKeys:");
    expect(spec).toContain("UpdateDocumentTypeCatalogRequest:");
    expect(spec).toContain("operationId: getDocumentTypeCatalog");
    expect(spec).toContain("operationId: updateDocumentTypeCatalog");
    // The extended enrichment provenance is public API too.
    expect(spec).toContain("matchedTypeKey:");
    expect(spec).toContain("generatedKeys:");
  });
});

it("documents catalog update fields with defaults as optional", () => {
  const spec = JSON.parse(
    readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
  ) as {
    components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
  };

  const request = spec.components.schemas.UpdateDocumentTypeCatalogRequest;
  // The route defaults every field but expectedRevision, so generated clients
  // must be able to omit them; a stricter required list breaks SDK compiles.
  expect(request.required).toEqual(["expectedRevision"]);

  // openapi-typescript renders `default`-annotated properties as required in
  // generated types, so the documented request schema must not carry defaults.
  expect(request.properties?.types).not.toHaveProperty("default");
  expect(request.properties?.disabledBuiltInTypeKeys).not.toHaveProperty("default");

  const typeSchema = (request.properties?.types as { items?: { required?: string[] } }).items;
  expect(typeSchema?.required).toEqual(["key", "label"]);

  const fieldSchema = (
    (typeSchema as { properties?: { fields?: { items?: { required?: string[] } } } }).properties?.fields
  )?.items;
  expect(fieldSchema?.required).toEqual(["key", "label", "valueType"]);
});
