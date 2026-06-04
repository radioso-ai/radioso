import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { README_SECTION } from "../src/import/buildDocuments.ts";
import { buildReadmeDocuments } from "../src/readme/buildReadmeDocuments.ts";

describe("buildReadmeDocuments", () => {
  it("builds sorted README documents with titles, raw markdown, and GitHub metadata URLs", async () => {
    const root = path.join(tmpdir(), `radioso-readmes-${crypto.randomUUID()}`);
    await mkdir(path.join(root, "packages", "sdk"), { recursive: true });
    await mkdir(path.join(root, "docs", "guide"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "Intro line\n\n# Root Title\n\nBody.   \n\n");
    await writeFile(path.join(root, "packages", "sdk", "readme.md"), "No heading\n");
    await writeFile(path.join(root, "docs", "guide", "README.md"), "# Guide Title\n\nGuide body.\n");
    await writeFile(path.join(root, "node_modules", "ignored", "README.md"), "# Ignored\n");
    await writeFile(path.join(root, "dist", "README.md"), "# Also ignored\n");

    const documents = await buildReadmeDocuments({
      repoRoot: root,
      commonSourceUrl: "https://docs.radioso.dev",
      repoSourceBase: "https://github.com/radioso-ai/radioso/blob/main",
    });

    expect(documents.map((document) => document.externalDocumentId)).toEqual([
      "repo-readme:README.md",
      "repo-readme:docs/guide/README.md",
      "repo-readme:packages/sdk/readme.md",
    ]);
    expect(documents.map((document) => document.title)).toEqual([
      "Root Title",
      "Guide Title",
      "packages/sdk/readme.md",
    ]);
    expect(documents[0]?.content).toBe("Intro line\n\n# Root Title\n\nBody.");
    expect(documents[0]?.source).toEqual({ kind: "website", url: "https://docs.radioso.dev" });
    expect(documents[0]?.metadata).toEqual({
      section: README_SECTION,
      path: "README.md",
      url: "https://github.com/radioso-ai/radioso/blob/main/README.md",
    });
  });
});
