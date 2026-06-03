import { describe, expect, it } from "vitest";
import { convertOpenApiToDocuments } from "../src/openapi/convertOpenApi.ts";

const SPEC = {
  openapi: "3.1.0",
  tags: [{ name: "Documents" }, { name: "Auth" }],
  paths: {
    "/api/v1/document/": {
      post: {
        tags: ["Documents"],
        summary: "Create a document",
        description: "Creates a document and enqueues processing.",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/DocumentCreateRequest" } } },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DocumentOperationResponse" } } },
          },
        },
      },
      get: {
        tags: ["Documents"],
        summary: "List documents",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/v1/auth/token": {
      post: { tags: ["Auth"], summary: "Exchange token", responses: { "200": { description: "OK" } } },
    },
  },
  components: {
    schemas: {
      DocumentCreateRequest: {
        type: "object",
        required: ["title", "content"],
        properties: { title: { type: "string" }, content: { type: "string" }, metadata: { type: "object" } },
      },
      DocumentOperationResponse: {
        type: "object",
        properties: { documentId: { type: "string" }, status: { type: "string" } },
      },
    },
  },
};

const CITATION_BASE = "https://docs.radioso.dev";

function convert() {
  return convertOpenApiToDocuments(SPEC, { citationBase: CITATION_BASE });
}

describe("convertOpenApiToDocuments", () => {
  it("emits one document per tag", () => {
    const docs = convert();
    expect(docs.map((doc) => doc.tag).sort()).toEqual(["Auth", "Documents"]);
  });

  it("titles each document with its tag", () => {
    const docs = convert();
    const documentsDoc = docs.find((doc) => doc.tag === "Documents");
    expect(documentsDoc?.title).toContain("Documents");
  });

  it("lists each operation's method, path, and summary under its tag", () => {
    const documentsDoc = convert().find((doc) => doc.tag === "Documents");
    expect(documentsDoc?.markdown).toContain("POST");
    expect(documentsDoc?.markdown).toContain("/api/v1/document/");
    expect(documentsDoc?.markdown).toContain("Create a document");
    expect(documentsDoc?.markdown).toContain("List documents");
    expect(documentsDoc?.markdown).toContain("Creates a document and enqueues processing.");
  });

  it("includes operation parameters", () => {
    const documentsDoc = convert().find((doc) => doc.tag === "Documents");
    expect(documentsDoc?.markdown).toContain("limit");
  });

  it("dereferences request and response schema properties", () => {
    const documentsDoc = convert().find((doc) => doc.tag === "Documents");
    // request body schema props
    expect(documentsDoc?.markdown).toContain("title");
    expect(documentsDoc?.markdown).toContain("content");
    // response schema props
    expect(documentsDoc?.markdown).toContain("documentId");
  });

  it("builds an absolute citation URL into the api-reference page", () => {
    const documentsDoc = convert().find((doc) => doc.tag === "Documents");
    expect(documentsDoc?.sourceUrl).toContain("https://docs.radioso.dev/api-reference");
    expect(documentsDoc?.sourceUrl).toContain("Documents");
  });

  it("groups operations under the tag they belong to", () => {
    const authDoc = convert().find((doc) => doc.tag === "Auth");
    expect(authDoc?.markdown).toContain("Exchange token");
    expect(authDoc?.markdown).not.toContain("Create a document");
  });
});
