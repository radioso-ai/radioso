import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

const collectTsFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(path));
    } else if (/\.(ts|tsx|d\.ts)$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
};

describe("customer email skill architecture boundary", () => {
  it("keeps conversation engine and routine runtime provider-free", () => {
    const files = [
      ...collectTsFiles(join(repoRoot, "packages/conversation-engine/src")),
      ...collectTsFiles(join(repoRoot, "packages/conversation-contract")),
      ...collectTsFiles(join(repoRoot, "backend/src/modules/routines")),
    ];

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /customerEmail\/providers|customerEmail\/services\/customerEmailDeliveryService|integrationOauth|Oauth|google_mail|microsoft_graph_mail/u.test(source);
    });

    expect(offenders).toEqual([]);
  });
});
