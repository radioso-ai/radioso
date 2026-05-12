import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SRC_ROOT = path.join(ROOT, "src");
const DIST_ROOT = path.join(ROOT, "dist", "src");

const copiedAssetExtensions = new Set([".json", ".md", ".sql"]);

const copyNonTsAssets = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyNonTsAssets(sourcePath);
      continue;
    }

    if (!entry.isFile() || !copiedAssetExtensions.has(path.extname(entry.name))) {
      continue;
    }

    const relativePath = path.relative(SRC_ROOT, sourcePath);
    const destinationPath = path.join(DIST_ROOT, relativePath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath);
  }
};

await copyNonTsAssets(SRC_ROOT);
