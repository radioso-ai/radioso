import { describe, expect, it } from "vitest";
import { deriveSlug } from "../src/import/buildDocuments.ts";

describe("deriveSlug", () => {
  it("strips the .mdx extension", () => {
    expect(deriveSlug("quickstarts/run-locally.mdx")).toBe("quickstarts/run-locally");
  });

  it("collapses a section index file to its directory", () => {
    expect(deriveSlug("why-radioso/index.mdx")).toBe("why-radioso");
  });

  it("maps the root index file to an empty slug", () => {
    expect(deriveSlug("index.mdx")).toBe("");
  });

  it("normalizes backslash path separators", () => {
    expect(deriveSlug("api\\documents-and-search.mdx")).toBe("api/documents-and-search");
  });
});
