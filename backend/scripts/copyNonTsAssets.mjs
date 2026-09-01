import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SRC_ROOT = path.join(ROOT, "src");
const DIST_ROOT = path.join(ROOT, "dist", "src");

const copiedAssetExtensions = new Set([".json", ".md", ".sql"]);

const assertMigrationArtifactsMatch = async () => {
  const sourceDirectory = path.join(SRC_ROOT, "db", "migrations");
  const destinationDirectory = path.join(DIST_ROOT, "db", "migrations");
  const [sourceEntries, destinationEntries] = await Promise.all([
    readdir(sourceDirectory),
    readdir(destinationDirectory),
  ]);
  const sourceMigrations = sourceEntries.filter((entry) => entry.endsWith(".sql")).sort();
  const destinationMigrations = destinationEntries.filter((entry) => entry.endsWith(".sql")).sort();

  if (sourceMigrations.length !== destinationMigrations.length ||
      sourceMigrations.some((migration, index) => migration !== destinationMigrations[index])) {
    throw new Error(
      `Compiled migration artifacts differ from source. Source: ${sourceMigrations.join(", ")}; ` +
      `compiled: ${destinationMigrations.join(", ")}`,
    );
  }
};

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
await assertMigrationArtifactsMatch();
