import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { README_SECTION } from "../src/import/buildDocuments.ts";
import { buildReadmeDocuments } from "../src/readme/buildReadmeDocuments.ts";

describe("buildReadmeDocuments", () => {
  it("builds sorted README documents with titles, raw markdown, and GitHub metadata URLs", async () => {
    const root = path.join(tmpdir(), `radioso-readmes-${crypto.randomUUID()}`);
    await mkdir(path.join(root, "typescript-sdk"), { recursive: true });
    await mkdir(path.join(root, "packages", "wordpress-companion"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "Intro line\n\n# Root Title\n\nBody.   \n\n");
    await writeFile(path.join(root, "packages", "wordpress-companion", "readme.md"), "No heading\n");
    await writeFile(path.join(root, "typescript-sdk", "README.md"), "# SDK Title\n\nSDK body.\n");
    await writeFile(path.join(root, "node_modules", "ignored", "README.md"), "# Ignored\n");
    await writeFile(path.join(root, "dist", "README.md"), "# Also ignored\n");

    const documents = await buildReadmeDocuments({
      repoRoot: root,
      commonSourceUrl: "https://docs.radioso.ai",
      repoSourceBase: "https://github.com/radioso-ai/radioso/blob/main",
    });

    expect(documents.map((document) => document.externalDocumentId)).toEqual([
      "repo-readme:README.md",
      "repo-readme:packages/wordpress-companion/readme.md",
      "repo-readme:typescript-sdk/README.md",
    ]);
    expect(documents.map((document) => document.title)).toEqual([
      "Root Title",
      "packages/wordpress-companion/readme.md",
      "SDK Title",
    ]);
    expect(documents[0]?.content).toBe("Intro line\n\n# Root Title\n\nBody.");
    expect(documents[0]?.source).toEqual({ kind: "website", url: "https://docs.radioso.ai" });
    expect(documents[0]?.metadata).toEqual({
      section: README_SECTION,
      path: "README.md",
      url: "https://github.com/radioso-ai/radioso/blob/main/README.md",
    });
  });

  it("skips READMEs that are internal briefs, fixtures, contracts, or infra", async () => {
    const root = path.join(tmpdir(), `radioso-readmes-${crypto.randomUUID()}`);
    const internal = [
      "frontend/README.md",
      "frontend/lib/README.md",
      "backend/src/modules/chat/README.md",
      "backend/tests/fixtures/email-channel/README.md",
      "specs/092-slack-channel/contracts/README.md",
      "infra/terraform/foundation/README.md",
      "docs/README.md",
      "ee/readme.md",
      "packages/radioso-mcp-server/src/README.md",
      // Covered by guides/mcp-server; its env-var setup answered "How do I set up Radioso?".
      "packages/radioso-mcp-server/README.md",
      "typescript-sdk/src/README.md",
    ];
    for (const rel of [...internal, "readme.md", "packages/wordpress-companion/README.md"]) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), `# ${rel}\n`);
    }

    const documents = await buildReadmeDocuments({
      repoRoot: root,
      commonSourceUrl: "https://docs.radioso.ai",
      repoSourceBase: "https://github.com/radioso-ai/radioso/blob/main",
    });

    expect(documents.map((document) => document.externalDocumentId)).toEqual([
      "repo-readme:packages/wordpress-companion/README.md",
      "repo-readme:readme.md",
    ]);
  });
});
