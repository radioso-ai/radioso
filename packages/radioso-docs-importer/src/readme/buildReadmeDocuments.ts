import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DocumentInput } from "../import/buildDocuments.ts";
import { README_SECTION } from "../import/buildDocuments.ts";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".next", "build", "coverage", "out", ".turbo", ".vercel"]);

/**
 * READMEs are grounding for the customer-facing support agent, so only the ones
 * a person outside the team installs, runs, or integrates with are imported.
 * Every other README is an area brief for coding agents (see AGENTS.md), a test
 * fixture, a spec contract, terraform, or an internal package, and imported
 * alongside the guides they outrank them in retrieval with local dev notes.
 *
 * An allowlist rather than an exclusion list, so a new README is internal until
 * someone decides it is product-facing. Paths are repo-relative, POSIX, and
 * compared case-insensitively (the repo mixes README.md and readme.md).
 */
const PRODUCT_README_PATHS: ReadonlySet<string> = new Set([
  "readme.md", // product overview and quick start
  "typescript-sdk/readme.md", // published SDK
  "packages/radioso-mcp-server/readme.md", // MCP server setup and client configuration
  "packages/wordpress-companion/readme.md", // WordPress plugin install
]);

function isProductReadme(relPath: string): boolean {
  return PRODUCT_README_PATHS.has(relPath.toLowerCase());
}

interface BuildReadmeDocumentsOptions {
  repoRoot: string;
  commonSourceUrl: string;
  repoSourceBase: string;
}

export async function buildReadmeDocuments(options: BuildReadmeDocumentsOptions): Promise<DocumentInput[]> {
  const repoRoot = path.resolve(options.repoRoot);
  const repoSourceBase = options.repoSourceBase.replace(/\/+$/, "");
  const files = (await listReadmeFiles(repoRoot))
    .filter((file) => isProductReadme(toPosixPath(path.relative(repoRoot, file))))
    .sort((a, b) =>
    comparePath(toPosixPath(path.relative(repoRoot, a)), toPosixPath(path.relative(repoRoot, b))),
  );
  const documents: DocumentInput[] = [];

  for (const absolutePath of files) {
    const relPath = toPosixPath(path.relative(repoRoot, absolutePath));
    const markdown = await readFile(absolutePath, "utf8");
    documents.push({
      externalDocumentId: `${README_SECTION}:${relPath}`,
      title: readTitle(markdown) ?? relPath,
      content: trimTrailingWhitespace(markdown),
      source: { kind: "website", url: options.commonSourceUrl },
      metadata: {
        section: README_SECTION,
        path: relPath,
        url: `${repoSourceBase}/${relPath}`,
      },
    });
  }

  return documents;
}

async function listReadmeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      files.push(...(await listReadmeFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase() === "readme.md") {
      files.push(full);
    }
  }

  return files;
}

function readTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match?.[1] ?? null;
}

function trimTrailingWhitespace(markdown: string): string {
  return markdown.replace(/\s+$/u, "");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function comparePath(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
