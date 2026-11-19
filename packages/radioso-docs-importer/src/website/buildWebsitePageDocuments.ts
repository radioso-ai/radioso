import type { DocumentInput } from "../import/buildDocuments.ts";
import { WEBSITE_SECTION } from "../import/buildDocuments.ts";

/** A public markdown page to import, and the URL citations should link to. */
export interface WebsitePageSpec {
  markdownUrl: string;
  citationUrl: string;
}

type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "statusText" | "text">>;

/**
 * Parse `--website-page <markdownUrl>=<citationUrl>`. Both must be absolute http(s)
 * URLs; the markdown URL is split from the citation URL at the first `=`, so it
 * must not carry a query string.
 */
export function parseWebsitePageSpec(value: string): WebsitePageSpec {
  const match = value.match(/^(https?:\/\/[^=\s]+)=(https?:\/\/\S+)$/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid --website-page "${value}": expected <markdownUrl>=<citationUrl> (absolute http(s) URLs).`);
  }
  return { markdownUrl: match[1], citationUrl: match[2] };
}

/** The id this importer stamps on the page, stable across runs and content edits. */
export function websitePageExternalId(citationUrl: string): string {
  const url = new URL(citationUrl);
  return `${WEBSITE_SECTION}:${url.pathname.replace(/\/+$/, "") || "/"}`;
}

/**
 * Fetch each page and build its document. Any failure (network, non-2xx, empty
 * body) throws: a silently dropped page would be pruned from the workspace.
 */
export async function buildWebsitePageDocuments(
  specs: WebsitePageSpec[],
  fetchPage: FetchLike = (url) => fetch(url, { headers: { accept: "text/markdown, text/plain;q=0.9" } }),
): Promise<DocumentInput[]> {
  const documents: DocumentInput[] = [];
  for (const spec of specs) {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchPage(spec.markdownUrl);
    } catch (error) {
      throw new Error(`Fetching ${spec.markdownUrl} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Fetching ${spec.markdownUrl} failed: ${response.status} ${response.statusText}`.trim());
    }
    const markdown = (await response.text()).replace(/\s+$/u, "");
    if (markdown === "") {
      throw new Error(`Fetching ${spec.markdownUrl} returned an empty page.`);
    }
    documents.push({
      externalDocumentId: websitePageExternalId(spec.citationUrl),
      title: markdown.match(/^#\s+(.+?)\s*$/m)?.[1] ?? spec.citationUrl,
      content: markdown,
      source: { kind: "website", url: new URL(spec.markdownUrl).origin },
      metadata: { section: WEBSITE_SECTION, url: spec.citationUrl },
    });
  }
  return documents;
}
