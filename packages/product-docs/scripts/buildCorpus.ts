/**
 * Compiles the published documentation portal into the corpus the product ships.
 *
 * The portal's MDX is the single source of truth: it is what readers see, so a shipped answer that
 * disagrees with it is a documentation bug rather than a second corpus to reconcile. The compiled
 * artifact is committed so the backend and MCP images stay self-contained — neither build stage
 * copies `docs-portal/`, and a runtime that had to reach the portal would answer about a release
 * the operator is not running. `--check` fails when the artifact drifts from the MDX.
 *
 * MDX flattening and slug derivation come from `@radioso/docs-importer`, which already owns them
 * for the hosted self-docs workspace. One converter means the text Ray reads, the text an MCP
 * client reads, and the text the hosted agent answers from are the same text.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import matter from "gray-matter";

import { deriveSlug } from "@radioso/docs-importer/src/import/buildDocuments.ts";
import { convertMdxDocument } from "@radioso/docs-importer/src/mdx/convertMdx.ts";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTENT_ROOT = path.resolve(PACKAGE_ROOT, "..", "..", "docs-portal", "content");
const OUTPUT_PATH = path.join(PACKAGE_ROOT, "src", "generated", "corpus.json");
const CITATION_BASE = "https://docs.radioso.ai";

const SECTION_LABELS: Record<string, string> = {
  api: "API reference",
  architecture: "Architecture",
  guides: "Guides",
  operators: "Operator guides",
  quickstarts: "Quickstarts",
  sdk: "TypeScript SDK",
  "why-radioso": "Why Radioso",
};

interface CorpusSection {
  id: string;
  heading: string;
  body: string;
}

interface CorpusPage {
  slug: string;
  url: string;
  title: string;
  description: string;
  section: string;
  lastUpdated: string | null;
  intro: string;
  sections: CorpusSection[];
}

const collectMdxFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMdxFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mdx")) {
      files.push(entryPath);
    }
  }

  return files;
};

const headingId = (heading: string): string => heading
  .toLowerCase()
  .replace(/`/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const trimBlankEdges = (lines: string[]): string => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
};

/**
 * Splits a page at its `##` headings so a long page can be read one section at a time. Fenced
 * blocks are tracked because a `##` comment inside an example is not a section boundary.
 */
const splitSections = (markdown: string): { intro: string; sections: CorpusSection[] } => {
  const intro: string[] = [];
  const sections: CorpusSection[] = [];
  let current: { id: string; heading: string; body: string[] } | null = null;
  let fence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      fence = fence === null ? marker : (fence === marker ? null : fence);
    }

    const heading = fence === null ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      if (current) sections.push({ ...current, body: trimBlankEdges(current.body) });
      current = { id: headingId(heading[1]), heading: heading[1], body: [] };
      continue;
    }

    if (current) {
      current.body.push(line);
      continue;
    }

    // The H1 restates the frontmatter title, which every projection already carries.
    if (!/^#\s+/.test(line)) intro.push(line);
  }

  if (current) sections.push({ ...current, body: trimBlankEdges(current.body) });

  return { intro: trimBlankEdges(intro), sections };
};

const buildCorpus = async () => {
  const files = (await collectMdxFiles(CONTENT_ROOT)).sort();
  const pages: CorpusPage[] = [];

  for (const file of files) {
    const relativePath = path.relative(CONTENT_ROOT, file);
    const source = await readFile(file, "utf8");
    const slug = deriveSlug(relativePath) || "index";
    const converted = convertMdxDocument(source, { slug, citationBase: CITATION_BASE });
    if (!converted.description) {
      throw new Error(`${relativePath} needs a description in its frontmatter.`);
    }

    // YAML parses a bare `2026-09-08` into a Date at UTC midnight; both forms normalize to the same
    // ISO day the frontmatter shows.
    const rawLastUpdated: unknown = matter(source).data.last_updated;
    const lastUpdated = rawLastUpdated instanceof Date
      ? rawLastUpdated.toISOString().slice(0, 10)
      : rawLastUpdated;
    const url = slug === "index" ? CITATION_BASE : `${CITATION_BASE}/${slug}`;
    const { intro, sections } = splitSections(converted.markdown);

    pages.push({
      slug,
      url,
      title: converted.title,
      description: converted.description,
      section: SECTION_LABELS[slug.split("/")[0]] ?? "Overview",
      lastUpdated: lastUpdated === undefined ? null : String(lastUpdated),
      intro,
      sections,
    });
  }

  pages.sort((left, right) => left.slug.localeCompare(right.slug));
  return { generatedFrom: "docs-portal/content", citationBase: CITATION_BASE, pageCount: pages.length, pages };
};

const main = async () => {
  const corpus = await buildCorpus();
  const serialized = `${JSON.stringify(corpus, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const existing = await readFile(OUTPUT_PATH, "utf8").catch(() => null);
    if (existing !== serialized) {
      throw new Error(
        "Product documentation corpus is stale. Run `pnpm --filter @radioso/product-docs run sync` and commit the result.",
      );
    }
    process.stdout.write(`Product documentation corpus is current (${corpus.pageCount} pages).\n`);
    return;
  }

  await writeFile(OUTPUT_PATH, serialized, "utf8");
  process.stdout.write(`Wrote ${corpus.pageCount} pages to ${path.relative(PACKAGE_ROOT, OUTPUT_PATH)}.\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
