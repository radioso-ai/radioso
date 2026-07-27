import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const retrievalRoot = path.join(backendRoot, "src/modules/retrieval");

const listTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(target);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
};

describe("embedding generation architecture boundary", () => {
  it("does not export general embedding gateways or services from Retrieval", async () => {
    const source = await readFile(
      path.join(retrievalRoot, "public.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\bModelEmbeddingGateway\b/);
    expect(source).not.toMatch(/\bOpenAIEmbeddingGateway\b/);
    expect(source).not.toMatch(/\bEmbeddingGateway\b/);
    expect(source).not.toMatch(/\bEmbeddingService\b/);
  });

  it("has no legacy implementation or general embedding imports in Retrieval", async () => {
    const legacyPath = path.join(
      retrievalRoot,
      "services/embeddingService.ts",
    );
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const files = await listTypeScriptFiles(retrievalRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const importsLegacyGeneralContract = [
        ...source.matchAll(
          /import(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*["'][^"']*embeddingService\.js["']/g,
        ),
      ].some((match) =>
        /\b(?:ModelEmbeddingGateway|OpenAIEmbeddingGateway|EmbeddingGateway|EmbeddingService|EmbeddingRequestOptions)\b/
          .test(match[1] ?? ""),
      );
      if (
        importsLegacyGeneralContract ||
        source.includes("embeddingProvider.js") ||
        source.includes("embeddingGeneration.js")
      ) {
        offenders.push(path.relative(retrievalRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
