import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DocumentInput } from "../import/buildDocuments.ts";
import { README_SECTION } from "../import/buildDocuments.ts";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".next", "build", "coverage", "out", ".turbo", ".vercel"]);

export interface BuildReadmeDocumentsOptions {
  repoRoot: string;
  commonSourceUrl: string;
  repoSourceBase: string;
}

export async function buildReadmeDocuments(options: BuildReadmeDocumentsOptions): Promise<DocumentInput[]> {
  const repoRoot = path.resolve(options.repoRoot);
  const repoSourceBase = options.repoSourceBase.replace(/\/+$/, "");
  const files = (await listReadmeFiles(repoRoot)).sort((a, b) =>
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
