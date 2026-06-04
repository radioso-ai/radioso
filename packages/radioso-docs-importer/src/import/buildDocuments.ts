import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { convertMdxDocument } from "../mdx/convertMdx.ts";
import { convertOpenApiToDocuments } from "../openapi/convertOpenApi.ts";
import { buildReadmeDocuments } from "../readme/buildReadmeDocuments.ts";

/** The section tag stamped on each document, used to scope pruning per source. */
export const MDX_SECTION = "mdx-docs";
export const API_SECTION = "api-reference";
export const README_SECTION = "repo-readme";

/** A document ready to upsert through the Radioso REST API. */
export interface DocumentInput {
  externalDocumentId: string;
  title: string;
  content: string;
  source: { kind: "website"; url: string };
  metadata: Record<string, string>;
}

export interface BuildDocumentsOptions {
  contentDir: string;
  openApiPath: string;
  repoRoot: string;
  citationBase: string;
  repoSourceBase: string;
  includeMdx: boolean;
  includeApi: boolean;
  includeReadme: boolean;
}

export async function buildDocuments(options: BuildDocumentsOptions): Promise<DocumentInput[]> {
  const commonSourceUrl = options.citationBase.replace(/\/+$/, "");
  const repoSourceBase = options.repoSourceBase.replace(/\/+$/, "");
  const documents: DocumentInput[] = [];

  if (options.includeMdx) {
    documents.push(...(await buildMdxDocuments(options.contentDir, commonSourceUrl)));
  }
  if (options.includeApi) {
    documents.push(...(await buildApiDocuments(options.openApiPath, commonSourceUrl)));
  }
  if (options.includeReadme) {
    documents.push(
      ...(await buildReadmeDocuments({
        repoRoot: options.repoRoot,
        commonSourceUrl,
        repoSourceBase,
      })),
    );
  }

  return documents;
}

async function buildMdxDocuments(contentDir: string, citationBase: string): Promise<DocumentInput[]> {
  const files = await listMdxFiles(contentDir);
  const documents: DocumentInput[] = [];

  for (const absolutePath of files) {
    const relative = path.relative(contentDir, absolutePath);
    const slug = deriveSlug(relative);
    const source = await readFile(absolutePath, "utf8");
    const converted = convertMdxDocument(source, { slug: slug || "index", citationBase });
    const url = slug ? `${citationBase}/${slug}` : citationBase;
    const content = converted.description ? `${converted.description}\n\n${converted.markdown}` : converted.markdown;

    documents.push({
      externalDocumentId: `${MDX_SECTION}:${slug || "index"}`,
      title: converted.title,
      content,
      source: { kind: "website", url: citationBase },
      metadata: { section: MDX_SECTION, slug: slug || "index", url },
    });
  }

  return documents;
}

async function buildApiDocuments(openApiPath: string, citationBase: string): Promise<DocumentInput[]> {
  const raw = await readFile(openApiPath, "utf8");
  const spec = JSON.parse(raw);
  return convertOpenApiToDocuments(spec, { citationBase }).map((doc) => ({
    externalDocumentId: `${API_SECTION}:${doc.tag}`,
    title: doc.title,
    content: doc.markdown,
    source: { kind: "website", url: citationBase },
    metadata: { section: API_SECTION, tag: doc.tag, url: doc.sourceUrl },
  }));
}

async function listMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMdxFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      files.push(full);
    }
  }
  return files.sort();
}

/** Map a content-relative MDX path to its public docs slug. */
export function deriveSlug(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.mdx$/, "");
  if (normalized === "index") {
    return "";
  }
  return normalized.replace(/\/index$/, "");
}
