import corpus from "./generated/corpus.json" with { type: "json" };
import type { ProductDoc, ProductDocSection, ProductDocSummary } from "./types.js";

export type { ProductDoc, ProductDocSection, ProductDocSummary, ProductDocsCorpus } from "./types.js";

interface RawPage extends Omit<ProductDocSummary, "headings"> {
  readonly intro: string;
  readonly sections: readonly ProductDocSection[];
}

const pages: readonly ProductDoc[] = (corpus.pages as readonly RawPage[]).map((page) => ({
  ...page,
  headings: page.sections.map((section) => section.heading),
}));

const bySlug = new Map(pages.map((page) => [page.slug, page]));

const summarize = ({ intro: _intro, sections: _sections, ...summary }: ProductDoc): ProductDocSummary => summary;

/**
 * Accepts what a reader would copy out of the portal — the page's own absolute URL, a path, a
 * leading or trailing slash, or the bare slug — so a caller that has only seen
 * `https://docs.radioso.ai/guides/mcp-server` does not have to know the corpus keys it as
 * `guides/mcp-server`.
 */
export const normalizeSlug = (slug: string): string => {
  const withoutOrigin = slug.trim().replace(/^https?:\/\/[^/]+/i, "");
  const trimmed = withoutOrigin.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "index" : trimmed;
};

/** Every page, ordered by slug. The caller decides how to group or bound them. */
export const listProductDocs = (): readonly ProductDocSummary[] => pages.map(summarize);

export const readProductDoc = (slug: string): ProductDoc | null => bySlug.get(normalizeSlug(slug)) ?? null;

export const readProductDocSection = (slug: string, sectionId: string): ProductDocSection | null => {
  const page = readProductDoc(slug);
  if (!page) {
    return null;
  }
  const wanted = sectionId.trim().toLowerCase();
  return page.sections.find((section) => section.id === wanted || section.heading.toLowerCase() === wanted) ?? null;
};

export const productDocsPageCount = pages.length;
