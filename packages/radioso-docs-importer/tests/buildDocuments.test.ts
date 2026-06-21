import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { API_SECTION, MDX_SECTION, README_SECTION, buildDocuments, deriveSlug } from "../src/import/buildDocuments.ts";

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

describe("buildDocuments", () => {
  it("builds MDX, API, and README documents under one common source with deep links in metadata.url", async () => {
    const root = path.join(tmpdir(), `radioso-docs-importer-${crypto.randomUUID()}`);
    const contentDir = path.join(root, "docs-portal", "content");
    const openApiPath = path.join(root, "backend", "openapi.json");
    await mkdir(contentDir, { recursive: true });
    await mkdir(path.dirname(openApiPath), { recursive: true });
    await writeFile(
      path.join(contentDir, "quickstart.mdx"),
      `---
title: Quickstart
---

# Quickstart

Run it.
`,
    );
    await writeFile(
      openApiPath,
      JSON.stringify({
        tags: [{ name: "Documents" }],
        paths: {
          "/api/v1/document/": {
            get: { tags: ["Documents"], summary: "List documents", responses: { "200": { description: "OK" } } },
          },
        },
      }),
    );
    await writeFile(path.join(root, "README.md"), "# Repo README\n\nRoot docs.\n");

    const documents = await buildDocuments({
      contentDir,
      openApiPath,
      repoRoot: root,
      citationBase: "https://docs.radioso.ai/",
      repoSourceBase: "https://github.com/radioso-ai/radioso/blob/main/",
      includeMdx: true,
      includeApi: true,
      includeReadme: true,
    });

    expect(new Set(documents.map((document) => document.source.url))).toEqual(new Set(["https://docs.radioso.ai"]));

    const mdx = documents.find((document) => document.externalDocumentId === `${MDX_SECTION}:quickstart`);
    expect(mdx?.metadata).toEqual({
      section: MDX_SECTION,
      slug: "quickstart",
      url: "https://docs.radioso.ai/quickstart",
    });

    const api = documents.find((document) => document.externalDocumentId === `${API_SECTION}:Documents`);
    expect(api?.metadata.section).toBe(API_SECTION);
    expect(api?.metadata.tag).toBe("Documents");
    expect(api?.metadata.url).toContain("https://docs.radioso.ai/api-reference#tag/Documents");

    const readme = documents.find((document) => document.externalDocumentId === `${README_SECTION}:README.md`);
    expect(readme?.metadata).toEqual({
      section: README_SECTION,
      path: "README.md",
      url: "https://github.com/radioso-ai/radioso/blob/main/README.md",
    });
  });
});
